import { join } from "node:path";
import { detailRank } from "./analyze.ts";

// Raw facts from the GitHub REST API. Read-only; nothing here writes to GitHub.
// GitLab (src/forges/gitlab.ts) produces the same shapes, so analysis works on either or both.

export type Forge = "github" | "gitlab";

export interface RepoFacts {
  /** Where the repo lives. Missing means GitHub (data cached before GitLab support). */
  forge?: Forge;
  /** Host for self-hosted GitLab, e.g. "gitlab.example.com". */
  host?: string;
  /** The same project on another forge (a mirror), after merging accounts. */
  alsoOn?: string[];
  name: string;
  fullName: string;
  url: string;
  description?: string;
  homepage?: string;
  fork: boolean;
  archived: boolean;
  stars: number;
  forks: number;
  openIssues: number;
  language?: string;
  topics: string[];
  license?: string;
  createdAt: string;
  pushedAt: string;
  sizeKb: number;
  /** Bytes per language (only collected for detailed repos). */
  languages?: Record<string, number>;
  /** README text, truncated (only collected for detailed repos). */
  readme?: string;
  /** Dependency manifests by filename (only collected for detailed repos). */
  manifests?: Record<string, string>;
}

export interface GitHubData {
  forge?: Forge;
  host?: string;
  /** The account's profile page, e.g. https://github.com/ada. */
  profileUrl?: string;
  user: {
    login: string;
    name?: string;
    bio?: string;
    blog?: string;
    company?: string;
    location?: string;
    followers: number;
    publicRepos: number;
    createdAt: string;
  };
  repos: RepoFacts[];
  collectedAt: string;
}

const API = "https://api.github.com";
const MANIFESTS = ["composer.json", "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt", "Gemfile"];
const README_LIMIT = 6000;

export const CACHE_DIR = process.env.RESUME_CACHE_DIR ?? ".cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** GITHUB_TOKEN, else the gh CLI's token, else unauthenticated (60 requests/hour). */
export async function githubToken(): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const token = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && token ? token : undefined;
  } catch {
    return undefined;
  }
}

export class GitHubClient {
  calls = 0;
  constructor(private token?: string) {}

  private async request(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    this.calls++;
    const res = await fetch(`${API}${path}`, {
      headers: {
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "resume-manager",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error("GitHub rate limit reached. Set GITHUB_TOKEN or log in with `gh auth login`.");
    }
    return res;
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
    return res.json() as Promise<T>;
  }

  /** Raw file contents, or undefined if missing. */
  async raw(path: string): Promise<string | undefined> {
    const res = await this.request(path, "application/vnd.github.raw+json");
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
    return res.text();
  }
}

type ApiRepo = {
  name: string; full_name: string; html_url: string; description: string | null; homepage: string | null;
  fork: boolean; archived: boolean; stargazers_count: number; forks_count: number; open_issues_count: number;
  language: string | null; topics?: string[]; license: { spdx_id: string } | null;
  created_at: string; pushed_at: string; size: number; owner: { login: string };
};

const toFacts = (r: ApiRepo): RepoFacts => ({
  forge: "github",
  name: r.name,
  fullName: r.full_name,
  url: r.html_url,
  description: r.description ?? undefined,
  homepage: r.homepage || undefined,
  fork: r.fork,
  archived: r.archived,
  stars: r.stargazers_count,
  forks: r.forks_count,
  openIssues: r.open_issues_count,
  language: r.language ?? undefined,
  topics: r.topics ?? [],
  license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : undefined,
  createdAt: r.created_at,
  pushedAt: r.pushed_at,
  sizeKb: r.size,
});

export interface CollectOptions {
  /** How many repos get the expensive detail pass (languages, README, manifests). */
  detailed?: number;
  /** Pick which repos get details; defaults to portfolio score with language diversity. */
  rank?: (repos: RepoFacts[]) => RepoFacts[];
  refresh?: boolean;
  onProgress?: (message: string) => void;
  client?: GitHubClient;
}

export async function collect(username: string, opts: CollectOptions = {}): Promise<GitHubData> {
  const cacheFile = join(CACHE_DIR, "github", `${username.toLowerCase()}.json`);
  const cached = Bun.file(cacheFile);
  if (!opts.refresh && (await cached.exists())) {
    const data = (await cached.json()) as GitHubData;
    if (Date.now() - Date.parse(data.collectedAt) < CACHE_TTL_MS) return data;
  }

  const gh = opts.client ?? new GitHubClient(await githubToken());
  const progress = opts.onProgress ?? (() => {});

  progress(`profile ${username}`);
  const u = await gh.json<{
    login: string; name: string | null; bio: string | null; blog: string | null; company: string | null;
    location: string | null; followers: number; public_repos: number; created_at: string;
  }>(`/users/${encodeURIComponent(username)}`);

  const repos: RepoFacts[] = [];
  for (let page = 1; page <= 10; page++) {
    progress(`repositories page ${page}`);
    const batch = await gh.json<ApiRepo[]>(`/users/${encodeURIComponent(username)}/repos?type=owner&sort=pushed&per_page=100&page=${page}`);
    repos.push(...batch.map(toFacts));
    if (batch.length < 100) break;
  }

  const rank = opts.rank ?? detailRank;
  const detailed = rank(repos.filter((r) => !r.fork)).slice(0, opts.detailed ?? 16);
  for (const [i, repo] of detailed.entries()) {
    progress(`details ${i + 1}/${detailed.length}: ${repo.name}`);
    const base = `/repos/${repo.fullName}`;
    repo.languages = await gh.json<Record<string, number>>(`${base}/languages`);
    repo.readme = (await gh.raw(`${base}/readme`))?.slice(0, README_LIMIT);
    repo.manifests = {};
    // Only fetch manifests the primary language suggests, to keep request counts down.
    for (const file of manifestsFor(repo)) {
      const body = await gh.raw(`${base}/contents/${file}`);
      if (body) repo.manifests[file] = body.slice(0, 20_000);
    }
  }

  const data: GitHubData = {
    forge: "github",
    host: "github.com",
    profileUrl: `https://github.com/${u.login}`,
    user: {
      login: u.login,
      name: u.name ?? undefined,
      bio: u.bio ?? undefined,
      blog: u.blog || undefined,
      company: u.company ?? undefined,
      location: u.location ?? undefined,
      followers: u.followers,
      publicRepos: u.public_repos,
      createdAt: u.created_at,
    },
    repos,
    collectedAt: new Date().toISOString(),
  };
  await Bun.write(cacheFile, JSON.stringify(data, null, 2));
  return data;
}

function manifestsFor(repo: RepoFacts): string[] {
  const langs = new Set([repo.language, ...Object.keys(repo.languages ?? {})].filter(Boolean));
  const out = new Set<string>();
  if (langs.has("PHP") || langs.has("Blade")) out.add("composer.json");
  if (langs.has("JavaScript") || langs.has("TypeScript") || langs.has("Vue") || langs.has("Svelte")) out.add("package.json");
  if (langs.has("Go")) out.add("go.mod");
  if (langs.has("Rust")) out.add("Cargo.toml");
  if (langs.has("Python")) (out.add("pyproject.toml"), out.add("requirements.txt"));
  if (langs.has("Ruby")) out.add("Gemfile");
  // Plenty of PHP packages ship JS tooling too; check package.json for PHP repos with a front end.
  if (langs.has("PHP") && (langs.has("JavaScript") || langs.has("TypeScript"))) out.add("package.json");
  return [...out].filter((f) => MANIFESTS.includes(f));
}

/** "GitHub", "GitLab", or the host for self-hosted GitLab. */
export function forgeLabel(r: { forge?: Forge; host?: string }): string {
  if ((r.forge ?? "github") === "github") return "GitHub";
  return !r.host || r.host === "gitlab.com" ? "GitLab" : r.host;
}
