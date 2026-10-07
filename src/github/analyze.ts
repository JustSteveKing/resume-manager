import type { GitHubData, RepoFacts } from "./collect.ts";

// Deterministic analysis: everything here is derived from GitHub data, no AI involved.

export interface LanguageStat {
  name: string;
  /** Repos where this is the primary language (originals only). */
  repos: number;
  /** Primary-language repos weighted by recency (active in 2 years = 1, older = 0.4). Used for ranking. */
  weight: number;
  /** Share of code bytes across detailed repos, 0-1. */
  share: number;
  lastUsed: string;
}

export interface Evidence {
  name: string;
  /** Repos that show it (manifests or topics). */
  repos: string[];
  lastUsed: string;
  source: "dependency" | "topic";
}

export interface ScoredRepo {
  repo: RepoFacts;
  score: number;
  reasons: string[];
}

export interface GitHubAnalysis {
  login: string;
  languages: LanguageStat[];
  tools: Evidence[];
  portfolio: ScoredRepo[];
  stats: { originals: number; forks: number; stars: number; activeLastYear: number; yearsOnGitHub: number };
}

const NOISE_LANGUAGES = new Set(["Dockerfile", "Makefile", "Procfile", "Batchfile", "Roff", "MDX"]);
// Topics that say nothing about skills.
const NOISE_TOPICS = new Set(["hacktoberfest", "hacktoberfest2020", "hacktoberfest2021", "hacktoberfest2022", "hacktoberfest2023", "awesome", "awesome-list", "hacktoberfest-accepted"]);
// Topics that are really a language (dropped) or a tool name (folded into it).
const TOPIC_ALIASES: Record<string, string> = {
  golang: "Go", go: "Go", php: "PHP", typescript: "TypeScript", javascript: "JavaScript", rust: "Rust", python: "Python",
  laravel: "Laravel", symfony: "Symfony", pest: "Pest", phpunit: "PHPUnit", react: "React", vue: "Vue", vuejs: "Vue",
  tailwindcss: "Tailwind CSS", bubbletea: "Bubble Tea", livewire: "Livewire", inertiajs: "Inertia",
};

// Dependency name → skill. Prefix entries end with "/".
const COMPOSER: Record<string, string> = {
  "laravel/framework": "Laravel", "illuminate/": "Laravel", "laravel/": "Laravel",
  "symfony/": "Symfony", "livewire/livewire": "Livewire", "inertiajs/inertia-laravel": "Inertia",
  "pestphp/pest": "Pest", "phpunit/phpunit": "PHPUnit", "phpstan/phpstan": "PHPStan", "larastan/larastan": "PHPStan",
  "nunomaduro/larastan": "PHPStan", "laravel/pint": "Laravel Pint", "rector/rector": "Rector",
  "guzzlehttp/guzzle": "Guzzle", "saloonphp/saloon": "Saloon", "openai-php/": "OpenAI API",
  "php-http/": "PSR HTTP", "psr/": "PSR standards", "league/": "The PHP League",
};
const NPM: Record<string, string> = {
  react: "React", vue: "Vue", next: "Next.js", svelte: "Svelte", astro: "Astro", express: "Express", hono: "Hono",
  tailwindcss: "Tailwind CSS", typescript: "TypeScript", vite: "Vite", vitest: "Vitest", jest: "Jest",
  "@inertiajs/": "Inertia", alpinejs: "Alpine.js", "@anthropic-ai/sdk": "Claude API", openai: "OpenAI API",
  zod: "Zod", "@opentui/": "OpenTUI", prisma: "Prisma", "drizzle-orm": "Drizzle", "@tabstack/sdk": "Tabstack",
  puppeteer: "Puppeteer", playwright: "Playwright", "@playwright/test": "Playwright",
};
const GO: Record<string, string> = {
  "github.com/gin-gonic/gin": "Gin", "github.com/labstack/echo": "Echo", "github.com/spf13/cobra": "Cobra",
  "github.com/charmbracelet/bubbletea": "Bubble Tea", "gorm.io/gorm": "GORM", "github.com/go-chi/chi": "chi",
};
const CARGO: Record<string, string> = { tokio: "Tokio", axum: "Axum", serde: "Serde", clap: "clap" };
const PYTHON: Record<string, string> = { django: "Django", flask: "Flask", fastapi: "FastAPI", pandas: "pandas" };

const lookup = (map: Record<string, string>, dep: string) =>
  map[dep] ?? Object.entries(map).find(([k]) => k.endsWith("/") && dep.startsWith(k))?.[1];

function jsonDeps(text: string, keys: string[]): string[] {
  try {
    const json = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    return keys.flatMap((k) => Object.keys(json[k] ?? {}));
  } catch {
    return [];
  }
}

/** Skills a repo demonstrates through its dependency manifests. */
export function detectTools(repo: RepoFacts): string[] {
  const found = new Set<string>();
  const m = repo.manifests ?? {};
  if (m["composer.json"]) {
    for (const dep of jsonDeps(m["composer.json"], ["require", "require-dev"])) {
      const hit = lookup(COMPOSER, dep);
      if (hit) found.add(hit);
    }
    try {
      if ((JSON.parse(m["composer.json"]) as { type?: string }).type === "library") found.add("PHP package development");
    } catch { /* ignore malformed manifests */ }
  }
  if (m["package.json"]) {
    for (const dep of jsonDeps(m["package.json"], ["dependencies", "devDependencies", "peerDependencies"])) {
      const hit = lookup(NPM, dep);
      if (hit) found.add(hit);
    }
  }
  if (m["go.mod"]) {
    for (const [mod, name] of Object.entries(GO)) if (m["go.mod"].includes(mod)) found.add(name);
  }
  if (m["Cargo.toml"]) {
    for (const [crate, name] of Object.entries(CARGO)) if (new RegExp(`^${crate}\\s*=`, "m").test(m["Cargo.toml"])) found.add(name);
  }
  const py = `${m["pyproject.toml"] ?? ""}\n${m["requirements.txt"] ?? ""}`.toLowerCase();
  for (const [pkg, name] of Object.entries(PYTHON)) if (new RegExp(`(^|["\\s])${pkg}([\\s=<>~"\\[]|$)`, "m").test(py)) found.add(name);
  return [...found];
}

const YEAR = 365 * 24 * 60 * 60 * 1000;

/** Highest score first; ties go to the most recently pushed repo. */
const byScore = (a: ScoredRepo, b: ScoredRepo) => b.score - a.score || b.repo.pushedAt.localeCompare(a.repo.pushedAt);
const age = (iso: string, now: number) => (now - Date.parse(iso)) / YEAR;

/** Portfolio score: popularity (log-scaled), recency, presentation; penalties for forks, archives and scratch repos. */
export function scoreRepo(repo: RepoFacts, now = Date.now()): ScoredRepo {
  let score = 0;
  const reasons: string[] = [];
  if (repo.stars) {
    score += 3 * Math.log2(1 + repo.stars);
    reasons.push(`${repo.stars} stars`);
  }
  if (repo.forks) {
    score += 1.5 * Math.log2(1 + repo.forks);
    reasons.push(`${repo.forks} forks`);
  }
  const pushed = age(repo.pushedAt, now);
  if (pushed < 1) (score += 3, reasons.push("active this year"));
  else if (pushed < 2) (score += 1.5, reasons.push("active in the last 2 years"));
  if (repo.description) score += 1;
  else reasons.push("no description");
  if ((repo.readme?.length ?? 0) > 500) score += 1;
  if (repo.homepage) (score += 0.5, reasons.push("has a homepage"));
  if (repo.topics.length) score += 0.5;
  if (repo.archived) (score -= 2, reasons.push("archived"));
  // Repos that tell readers to use something else make weak portfolio pieces.
  const blurb = `${repo.description ?? ""}\n${repo.readme?.slice(0, 600) ?? ""}`;
  if (/\b(deprecated|no longer maintained|unmaintained|abandoned|frozen|recommend using \S+ (instead|for))\b/i.test(blurb)) {
    score -= 6;
    reasons.push("marked deprecated/frozen");
  }
  if (repo.fork) (score -= 10, reasons.push("fork"));
  if (/^(dotfiles|\.github|config|demo|test|playground|scratch|sandbox)/i.test(repo.name) || repo.name.toLowerCase() === repo.fullName.split("/")[0]!.toLowerCase()) {
    score -= 3;
    reasons.push("looks like a config/scratch repo");
  }
  if (repo.sizeKb < 20) (score -= 1, reasons.push("very small"));
  return { repo, score: Math.round(score * 10) / 10, reasons };
}

export function analyze(data: GitHubData, opts: { portfolioSize?: number; now?: number } = {}): GitHubAnalysis {
  const now = opts.now ?? Date.now();
  const originals = data.repos.filter((r) => !r.fork);

  // Languages: primary-language repo counts, plus byte share where we have detail.
  const langs = new Map<string, LanguageStat>();
  const totalBytes = originals.reduce((n, r) => n + Object.values(r.languages ?? {}).reduce((a, b) => a + b, 0), 0);
  for (const r of originals) {
    const names = new Set([r.language, ...Object.keys(r.languages ?? {})].filter((l): l is string => !!l && !NOISE_LANGUAGES.has(l)));
    for (const name of names) {
      const stat = langs.get(name) ?? { name, repos: 0, weight: 0, share: 0, lastUsed: r.pushedAt };
      if (r.language === name) {
        stat.repos++;
        stat.weight += age(r.pushedAt, now) < 2 ? 1 : 0.4;
      }
      stat.share += (r.languages?.[name] ?? 0) / (totalBytes || 1);
      if (r.pushedAt > stat.lastUsed) stat.lastUsed = r.pushedAt;
      langs.set(name, stat);
    }
  }
  const languages = [...langs.values()]
    .map((l) => ({ ...l, share: Math.round(l.share * 1000) / 1000, weight: Math.round(l.weight * 10) / 10 }))
    // A language needs to be the primary language of 2+ repos to count as a skill.
    .filter((l) => l.repos >= 2)
    .sort((a, b) => b.weight - a.weight || b.share - a.share);
  const languageNames = new Set(languages.map((l) => l.name.toLowerCase()));

  // Tools: from dependencies (strong evidence) and topics (weaker).
  const tools = new Map<string, Evidence>();
  const note = (name: string, repo: RepoFacts, source: Evidence["source"]) => {
    const e = tools.get(name) ?? { name, repos: [], lastUsed: repo.pushedAt, source };
    if (!e.repos.includes(repo.name)) e.repos.push(repo.name);
    if (repo.pushedAt > e.lastUsed) e.lastUsed = repo.pushedAt;
    if (source === "dependency") e.source = "dependency";
    tools.set(name, e);
  };
  for (const r of originals) {
    detectTools(r).forEach((t) => note(t, r, "dependency"));
    for (const topic of r.topics) {
      if (NOISE_TOPICS.has(topic)) continue;
      const name = TOPIC_ALIASES[topic] ?? topic;
      if (languageNames.has(name.toLowerCase())) continue; // already a language
      note(name, r, tools.get(name)?.source ?? "topic");
    }
  }

  const portfolio = originals
    .map((r) => scoreRepo(r, now))
    .sort(byScore)
    .slice(0, opts.portfolioSize ?? 8);

  return {
    login: data.user.login,
    languages,
    tools: [...tools.values()].sort((a, b) => (a.source === b.source ? 0 : a.source === "dependency" ? -1 : 1) || b.repos.length - a.repos.length),
    portfolio,
    stats: {
      originals: originals.length,
      forks: data.repos.length - originals.length,
      stars: originals.reduce((n, r) => n + r.stars, 0),
      activeLastYear: originals.filter((r) => age(r.pushedAt, now) < 1).length,
      yearsOnGitHub: Math.floor(age(data.user.createdAt, now)),
    },
  };
}

/**
 * Which repos deserve the detail pass: the best by portfolio score, plus the top two of every
 * language used as the primary language in 3+ repos, so a Go or TypeScript side of the work isn't missed.
 */
export function detailRank(repos: RepoFacts[], now = Date.now()): RepoFacts[] {
  const scored = repos.map((r) => scoreRepo(r, now)).sort(byScore).map((s) => s.repo);
  const counts = new Map<string, number>();
  repos.forEach((r) => r.language && counts.set(r.language, (counts.get(r.language) ?? 0) + 1));
  const diverse = [...counts].filter(([, n]) => n >= 3).flatMap(([lang]) => scored.filter((r) => r.language === lang).slice(0, 2));
  // Interleave: guaranteed diverse picks first among equals, then the rest by score.
  return [...new Set([...scored.slice(0, 6), ...diverse, ...scored])];
}
