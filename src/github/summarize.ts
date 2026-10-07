import { z } from "zod";
import type { Project, Skill } from "../schema.ts";
import { isGrounded } from "../grounding.ts";
import { tabstack, toTabstackSchema } from "../tabstack.ts";
import { CACHE_DIR } from "./collect.ts";
import { whereHosted } from "../forges/index.ts";
import type { GitHubAnalysis, ScoredRepo } from "./analyze.ts";
import { forgeLabel, type RepoFacts } from "./collect.ts";
import { detectTools } from "./analyze.ts";

// The "intelligence" layer: Tabstack generate turns analysed GitHub facts into resume copy.
// Every call is grounded in facts we collected; numbers the model can't back up are dropped.

const MAX_INSTRUCTIONS = 20_000;
const BATCH = 4;
const README_PER_REPO = 2_400;

export const SkillsSummary = z.object({
  summary: z
    .string()
    .describe(
      "2-3 sentence resume summary of their technical strengths. Start with what they are and build (e.g. 'PHP and Go engineer focused on…'). Never write 'this developer', 'they', 'he' or 'she'. At most one statistic.",
    ),
  skills: z
    .array(
      z.object({
        name: z.string().describe("Skill group: one of Languages, Frameworks, Testing & Quality, Tooling, APIs & Architecture, Front end"),
        keywords: z.array(z.string()).describe("Technologies or practices, strongest first. Never repository or project names"),
        evidence: z.string().describe("One sentence citing the repos or counts that show it"),
      }),
    )
    .describe("4-6 skill groups"),
});
export type SkillsSummary = z.infer<typeof SkillsSummary>;

export const PortfolioWriteups = z.object({
  projects: z.array(
    z.object({
      repo: z.string().describe("Exact repository name as given"),
      description: z.string().describe("1-2 sentence resume-ready description of what it is and who it helps"),
      highlights: z
        .array(z.string())
        .describe("2-3 short bullets on what it does and why it matters, from the README. Do not restate stars, forks or dates; those are added separately"),
      keywords: z.array(z.string()).describe("Technologies used, from the facts"),
      roles: z.array(z.string()).describe("e.g. Creator, Maintainer"),
    }),
  ),
});
export type PortfolioWriteups = z.infer<typeof PortfolioWriteups>;

const RULES = `Rules:
- Use ONLY the facts below. Never invent users, companies, downloads, percentages or dates.
- Any number you write must appear in the facts.
- Plain, specific, confident tone. No clichés ("passionate", "cutting-edge", "robust", "seamless"). British English.
- The fetched page is the developer's GitHub profile; use it only for extra context.`;

const year = (iso: string) => iso.slice(0, 4);

export function skillsFacts(a: GitHubAnalysis, bio?: string): string {
  const lines = [
    `Developer: ${a.login}${bio ? ` — bio: ${bio}` : ""}`,
    `Repositories: ${a.stats.originals} original repos, ${a.stats.stars} stars total, ${a.stats.activeLastYear} repos active in the last year, ${a.stats.yearsOnGitHub} years publishing code.`,
    "Languages (primary language of N repos, last used):",
    ...a.languages.slice(0, 12).map((l) => `- ${l.name}: ${l.repos} repos, last used ${year(l.lastUsed)}`),
    "Frameworks and tools (from dependency manifests unless marked topic):",
    ...a.tools.slice(0, 40).map((t) => `- ${t.name}${t.source === "topic" ? " (topic)" : ""}: ${t.repos.length} repos (${t.repos.slice(0, 4).join(", ")}), last used ${year(t.lastUsed)}`),
    "Most notable repositories:",
    ...a.portfolio.map((p) => `- ${p.repo.name}: ${p.repo.description ?? "no description"} (${p.repo.stars} stars)`),
  ];
  return lines.join("\n");
}

export function repoFacts(p: ScoredRepo): string {
  const r = p.repo;
  return [
    `### ${r.name}`,
    `url: ${r.url}`,
    `hosted: ${whereHosted(r)}`,
    `description: ${r.description ?? "none"}`,
    `primary language: ${r.language ?? "unknown"}; languages: ${Object.keys(r.languages ?? {}).join(", ") || "unknown"}`,
    `detected tools: ${detectTools(r).join(", ") || "none"}`,
    `topics: ${r.topics.join(", ") || "none"}`,
    `stars: ${r.stars}; forks: ${r.forks}; created: ${year(r.createdAt)}; last push: ${year(r.pushedAt)}${r.archived ? "; archived" : ""}${r.license ? `; license: ${r.license}` : ""}`,
    `README excerpt:\n${(r.readme ?? "").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").slice(0, README_PER_REPO)}`,
  ].join("\n");
}

export type Generate = (params: { url: string; instructions: string; json_schema: unknown }) => Promise<unknown>;

/**
 * Tabstack generate, cached by a hash of the exact request: re-running a scan whose facts
 * haven't changed costs nothing. Pass refresh to force a new call.
 */
export function cachedGenerate(refresh = false): Generate {
  return async (params) => {
    const key = Bun.hash(JSON.stringify(params)).toString(16);
    const file = Bun.file(`${CACHE_DIR}/tabstack/generate-${key}.json`);
    if (!refresh && (await file.exists())) return file.json();
    const res = await tabstack().generate.json(params);
    await Bun.write(file, JSON.stringify(res, null, 2));
    return res;
  };
}

const defaultGenerate: Generate = cachedGenerate();

const fitInstructions = (head: string, body: string) => (head + body).slice(0, MAX_INSTRUCTIONS);

/** The page Tabstack generate fetches for context: the developer's profile. */
const profilePage = (a: GitHubAnalysis, url?: string) => url ?? `https://github.com/${a.login}`;

export async function summarizeSkills(a: GitHubAnalysis, bio: string | undefined, generate = defaultGenerate, contextUrl?: string): Promise<SkillsSummary> {
  const res = await generate({
    url: profilePage(a, contextUrl),
    instructions: fitInstructions(
      `Summarise this developer's technical skills for their resume, grouped, strongest evidence first.\n${RULES}\n\nFACTS:\n`,
      skillsFacts(a, bio),
    ),
    json_schema: toTabstackSchema(SkillsSummary),
  });
  return groundSkills(SkillsSummary.parse(res), skillsFacts(a, bio));
}

/** Drop evidence sentences (and a summary) whose numbers aren't in the facts. */
export function groundSkills(s: SkillsSummary, facts: string): SkillsSummary {
  return {
    summary: s.summary
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => isGrounded(sentence, facts))
      .join(" "),
    skills: s.skills.map((g) => ({ ...g, evidence: isGrounded(g.evidence, facts) ? g.evidence : "" })),
  };
}

export async function writePortfolio(
  a: GitHubAnalysis,
  generate = defaultGenerate,
  onProgress?: (m: string) => void,
  contextUrl?: string,
): Promise<PortfolioWriteups["projects"]> {
  const out: PortfolioWriteups["projects"] = [];
  for (let i = 0; i < a.portfolio.length; i += BATCH) {
    const batch = a.portfolio.slice(i, i + BATCH);
    onProgress?.(`write-ups ${i + 1}-${i + batch.length} of ${a.portfolio.length}`);
    const res = await generate({
      url: profilePage(a, contextUrl),
      instructions: fitInstructions(
        `Write a resume portfolio entry for each repository below (${batch.map((p) => p.repo.name).join(", ")}).\n${RULES}\n\nFACTS:\n`,
        batch.map(repoFacts).join("\n\n"),
      ),
      json_schema: toTabstackSchema(PortfolioWriteups),
    });
    out.push(...PortfolioWriteups.parse(res).projects);
  }
  return out;
}

// ---------- grounding ----------

// Bullets that only restate metadata ("Has 217 stars", "Developed in 2020") add nothing to a resume.
const STAT_ONLY = /^(has|have|had|with|used by|developed in|created in|started in|written in|\d[\d,]*\s+(stars?|forks?))\b/i;
const NOISE_KEYWORDS = new Set(["hacktoberfest", "awesome", "github", "open-source", "opensource"]);

/** Case-insensitive dedupe, keeping first-seen order but the most capitalised spelling ("Laravel" over "laravel"). */
function cleanKeywords(words: string[]): string[] {
  const best = new Map<string, string>();
  const caps = (w: string) => (w.match(/[A-Z]/g) ?? []).length;
  for (const w of words) {
    const k = w.toLowerCase();
    if (NOISE_KEYWORDS.has(k)) continue;
    const prev = best.get(k);
    if (prev === undefined || caps(w) > caps(prev)) best.set(k, w);
  }
  return [...best.values()];
}

/** "412 stars and 24 forks on GitHub": the counts belong to that copy, so name its forge. */
export const popularity = (r: Pick<RepoFacts, "stars" | "forks" | "forge" | "host">) =>
  r.stars || r.forks ? `${r.stars} star${r.stars === 1 ? "" : "s"} and ${r.forks} fork${r.forks === 1 ? "" : "s"} on ${forgeLabel(r)}` : undefined;

export interface GroundedProject {
  project: Project;
  dropped: string[];
  scored: ScoredRepo;
}

/** Turn write-ups into JSON Resume projects, keeping only grounded claims. Falls back to facts for repos the model skipped. */
export function toProjects(a: GitHubAnalysis, writeups: PortfolioWriteups["projects"] = []): GroundedProject[] {
  return a.portfolio.map((scored) => {
    const r = scored.repo;
    const facts = repoFacts(scored);
    const w = writeups.find((x) => x.repo.toLowerCase() === r.name.toLowerCase());
    const dropped: string[] = [];
    const keep = (s: string) => {
      if (isGrounded(s, facts)) return true;
      dropped.push(s);
      return false;
    };
    const tools = detectTools(r);
    const description = w && keep(w.description) ? w.description : r.description;
    const highlights = (w?.highlights ?? []).filter((h) => !STAT_ONLY.test(h.trim())).filter(keep).slice(0, 3);
    // One accurate popularity line, written by us rather than the model.
    const pop = popularity(r);
    if (pop) highlights.push(pop);
    return {
      scored,
      dropped,
      project: {
        name: r.name,
        description,
        url: r.url,
        startDate: r.createdAt.slice(0, 7),
        endDate: r.archived ? r.pushedAt.slice(0, 7) : undefined,
        highlights,
        keywords: cleanKeywords([...(r.language ? [r.language] : []), ...tools, ...(w?.keywords ?? [])]).slice(0, 8),
        roles: w?.roles?.length ? w.roles : ["Creator", "Maintainer"],
      },
    };
  });
}

/** Skill groups as JSON Resume skills. Without AI, groups come straight from the analysis. */
export function toSkills(a: GitHubAnalysis, summary?: SkillsSummary, repoNames: string[] = a.portfolio.map((p) => p.repo.name)): Skill[] {
  if (summary) {
    const repos = new Set(repoNames.map((n) => n.toLowerCase().replace(/[-_]/g, " ")));
    return summary.skills
      .filter((g) => !/project|portfolio|notable|repositor/i.test(g.name))
      .map((g) => ({
        name: g.name,
        keywords: cleanKeywords(g.keywords.filter((k) => !repos.has(k.toLowerCase().replace(/[-_]/g, " ")) && !/repo/i.test(k))),
      }))
      .filter((g) => g.keywords.length);
  }
  const deps = a.tools.filter((t) => t.source === "dependency" && t.repos.length >= 2).map((t) => t.name);
  return [
    { name: "Languages", keywords: a.languages.slice(0, 6).map((l) => l.name) },
    { name: "Frameworks & Tools", keywords: deps.slice(0, 12) },
  ].filter((s) => s.keywords.length);
}

export { isGrounded, numbersIn } from "../grounding.ts";
