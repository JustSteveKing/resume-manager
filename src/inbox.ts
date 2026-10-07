import { join } from "node:path";
import { z } from "zod";
import { analyze, scoreRepo } from "./github/analyze.ts";
import { accountLabel, accountsFromResume, collectAccount, type Account } from "./forges/index.ts";
import type { GitLabClient } from "./forges/gitlab.ts";
import { CACHE_DIR, type GitHubClient, type RepoFacts } from "./github/collect.ts";
import { popularity, toProjects } from "./github/summarize.ts";
import type { Resume } from "./schema.ts";
import { sectionByKey, type SectionKey } from "./sections.ts";
import { isDuplicate, refreshSources, sourceLabel } from "./sources.ts";

// Brag-doc inbox: what changed since last time (new talks, new repos, star milestones),
// as suggestions you accept or dismiss. Run it on a schedule with `cv inbox`.

const INBOX_DIR = () => join(CACHE_DIR, "inbox");
const MILESTONES = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export const Suggestion = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  createdAt: z.string(),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("add"), section: z.string(), item: z.record(z.string(), z.any()) }),
    z.object({ type: z.literal("popularity"), project: z.string(), url: z.string(), line: z.string() }),
  ]),
});
export type Suggestion = z.infer<typeof Suggestion>;

const State = z.object({
  lastRun: z.string().optional(),
  repos: z.record(z.string(), z.object({ stars: z.number(), forks: z.number() })).default({}),
  dismissed: z.array(z.string()).default([]),
});

async function read<T extends z.ZodType>(name: string, schema: T, fallback: z.infer<T>): Promise<z.infer<T>> {
  const f = Bun.file(join(INBOX_DIR(), name));
  if (!(await f.exists())) return fallback;
  const parsed = schema.safeParse(await f.json());
  return parsed.success ? parsed.data : fallback;
}
const write = (name: string, value: unknown) => Bun.write(join(INBOX_DIR(), name), JSON.stringify(value, null, 2) + "\n");

export const loadSuggestions = () => read("suggestions.json", z.array(Suggestion), []);
const saveSuggestions = (s: Suggestion[]) => write("suggestions.json", s);

const crossed = (before: number, after: number) => MILESTONES.filter((m) => before < m && after >= m).at(-1);
const popularityLine = (r: RepoFacts) => popularity(r) ?? "";
/** State/suggestion key. GitHub keeps the bare name so history from before GitLab support carries over. */
const repoKey = (a: Account, name: string) => (a.forge === "github" ? name : `gitlab:${a.host ?? "gitlab.com"}:${name}`);

export interface InboxOptions {
  github?: boolean;
  sources?: boolean;
  onProgress?: (m: string) => void;
  /** Injected for tests. */
  client?: GitHubClient;
  gitlabClient?: GitLabClient;
  now?: Date;
}

export interface InboxRun {
  added: Suggestion[];
  /** First run only records a baseline for GitHub, so old popularity isn't reported as news. */
  baseline: boolean;
  errors: string[];
}

/** Collect new suggestions and add them to the inbox. */
export async function runInbox(r: Resume, opts: InboxOptions = {}): Promise<InboxRun> {
  const now = (opts.now ?? new Date()).toISOString();
  const state = await read("state.json", State, { repos: {}, dismissed: [] });
  const existing = await loadSuggestions();
  const known = new Set([...existing.map((s) => s.id), ...state.dismissed]);
  const added: Suggestion[] = [];
  const errors: string[] = [];
  const push = (s: Omit<Suggestion, "createdAt">) => {
    if (known.has(s.id)) return;
    known.add(s.id);
    added.push({ ...s, createdAt: now });
  };

  // 1. Saved sources: new talks, articles, projects…
  if (opts.sources !== false && r.meta?.sources?.length) {
    const copy = structuredClone(r);
    for (const res of await refreshSources(copy, (s) => opts.onProgress?.(`source ${sourceLabel(s)}`))) {
      if (res.kind === "error") errors.push(`${sourceLabel(res.source)}: ${res.error}`);
      if (res.kind !== "items") continue;
      for (const item of res.fresh) {
        const title = res.section.title(item) || "untitled";
        push({
          id: `add:${res.section.key}:${title.toLowerCase()}`,
          title: `New in ${res.section.label}: ${title}`,
          detail: `Found on ${sourceLabel(res.source)}`,
          action: { type: "add", section: res.section.key, item },
        });
      }
    }
  }

  // 2. GitHub and GitLab: new repos worth listing, and star milestones.
  const accounts = opts.github === false ? [] : accountsFromResume(r);
  let anyBaseline = false;
  for (const account of accounts) {
    // Each account gets its own baseline, so adding GitLab later doesn't flood the inbox.
    const known = Object.keys(state.repos).some((k) => (account.forge === "github" ? !k.startsWith("gitlab:") : k.startsWith(`gitlab:${account.host ?? "gitlab.com"}:`)));
    const baseline = !state.lastRun || !known;
    anyBaseline ||= baseline;
    try {
      const data = await collectAccount(account, { refresh: true, detailed: 8, onProgress: opts.onProgress, githubClient: opts.client, gitlabClient: opts.gitlabClient });
      const projects = sectionByKey("projects");
      const listed = (repo: RepoFacts) => r.projects.find((p) => p.url === repo.url || p.name.toLowerCase() === repo.name.toLowerCase());
      for (const repo of data.repos.filter((x) => !x.fork)) {
        const before = state.repos[repoKey(account, repo.name)];
        if (!baseline && !before && scoreRepo(repo).score >= 8 && repo.description) {
          const [project] = toProjects({ ...analyze({ ...data, repos: [repo] }), portfolio: [scoreRepo(repo)] });
          if (project && !isDuplicate(projects, r.projects, project.project)) {
            push({
              id: `repo:${repoKey(account, repo.name)}`,
              title: `New repo: ${repo.name}`,
              detail: repo.description,
              action: { type: "add", section: "projects", item: project.project },
            });
          }
        }
        const milestone = before ? crossed(before.stars, repo.stars) : undefined;
        if (!baseline && milestone) {
          const entry = listed(repo);
          push({
            id: `stars:${repoKey(account, repo.name)}:${milestone}`,
            title: `${repo.name} passed ${milestone} stars`,
            detail: entry ? `Update the popularity line on "${entry.name}"` : "Not in Projects yet; accepting adds it",
            action: entry
              ? { type: "popularity", project: entry.name, url: repo.url, line: popularityLine(repo) }
              : { type: "add", section: "projects", item: toProjects({ ...analyze({ ...data, repos: [repo] }), portfolio: [scoreRepo(repo)] })[0]!.project },
          });
        }
        state.repos[repoKey(account, repo.name)] = { stars: repo.stars, forks: repo.forks };
      }
    } catch (e) {
      errors.push(`${accountLabel(account)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  state.lastRun = now;
  await write("state.json", state);
  await saveSuggestions([...existing, ...added]);
  return { added, baseline: anyBaseline, errors };
}

/** Apply a suggestion to a resume (in place). */
export function applySuggestion(r: Resume, s: Suggestion) {
  if (s.action.type === "add") {
    (r[s.action.section as SectionKey] as Record<string, unknown>[]).push(s.action.item);
    return;
  }
  const { project, url, line } = s.action;
  const p = r.projects.find((x) => x.url === url || x.name === project);
  if (!p) return;
  const hs = p.highlights ?? [];
  const at = hs.findIndex((h) => /\d[\d,]* stars? and \d[\d,]* forks? on \S+/.test(h));
  if (at >= 0) hs[at] = line;
  else hs.push(line);
  p.highlights = hs;
}

/** Remove from the inbox; dismissed suggestions never come back. */
export async function resolveSuggestion(id: string, dismissed: boolean) {
  await saveSuggestions((await loadSuggestions()).filter((s) => s.id !== id));
  if (dismissed) {
    const state = await read("state.json", State, { repos: {}, dismissed: [] });
    state.dismissed = [...new Set([...state.dismissed, id])];
    await write("state.json", state);
  }
}
