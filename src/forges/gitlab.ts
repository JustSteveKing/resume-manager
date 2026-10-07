import { join } from "node:path";
import { detailRank } from "../github/analyze.ts";
import { CACHE_DIR, type CollectOptions, type GitHubData, type RepoFacts } from "../github/collect.ts";

// GitLab (gitlab.com or self-hosted) via the REST API v4. Read-only. Produces the same
// GitHubData shape as the GitHub collector so analysis, write-ups and evidence work unchanged.
//
// Without a token GitLab returns a slimmer project view: no fork or archive flags, and the
// user-detail endpoint is forbidden. Everything still works; a token adds fork detection.

const MANIFESTS_FOR: Record<string, string[]> = {
  PHP: ["composer.json"], Blade: ["composer.json"],
  JavaScript: ["package.json"], TypeScript: ["package.json"], Vue: ["package.json"], Svelte: ["package.json"],
  Go: ["go.mod"], Rust: ["Cargo.toml"], Python: ["pyproject.toml", "requirements.txt"], Ruby: ["Gemfile"],
};
const README_LIMIT = 6000;

export const DEFAULT_GITLAB_HOST = "https://gitlab.com";

/** Normalise "gitlab.example.com" / "https://gitlab.example.com/" → "https://gitlab.example.com". */
export function gitlabBase(host = process.env.GITLAB_HOST ?? DEFAULT_GITLAB_HOST): string {
  const withScheme = /^https?:\/\//.test(host) ? host : `https://${host}`;
  return withScheme.replace(/\/+$/, "");
}

/** GITLAB_TOKEN, else the glab CLI's token for this host, else none (public data only). */
export async function gitlabToken(base = gitlabBase()): Promise<string | undefined> {
  if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN;
  try {
    const proc = Bun.spawn(["glab", "config", "get", "token", "--host", new URL(base).host], { stdout: "pipe", stderr: "ignore" });
    const token = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && token ? token : undefined;
  } catch {
    return undefined;
  }
}

export class GitLabClient {
  calls = 0;
  constructor(
    readonly base = gitlabBase(),
    private token?: string,
  ) {}

  private async request(path: string): Promise<Response> {
    this.calls++;
    const res = await fetch(`${this.base}/api/v4${path}`, {
      headers: { "User-Agent": "resume-manager", ...(this.token ? { "PRIVATE-TOKEN": this.token } : {}) },
    });
    if (res.status === 429) throw new Error("GitLab rate limit reached. Add a GitLab token (Settings) or try again in a minute.");
    return res;
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw new Error(`GitLab ${res.status} for ${path}`);
    return res.json() as Promise<T>;
  }

  /** Raw file contents, or undefined if missing. */
  async raw(path: string): Promise<string | undefined> {
    const res = await this.request(path);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitLab ${res.status} for ${path}`);
    return res.text();
  }
}

type ApiUser = { id: number; username: string; name?: string; web_url: string; bio?: string; location?: string; website_url?: string; created_at?: string; followers?: number };
type ApiProject = {
  id: number; name: string; path_with_namespace: string; web_url: string; description: string | null;
  star_count: number; forks_count: number; open_issues_count?: number; topics?: string[]; tag_list?: string[];
  created_at: string; last_activity_at: string; default_branch?: string | null;
  archived?: boolean; forked_from_project?: unknown; license?: { key?: string } | null; namespace?: { path?: string };
};

const toFacts = (p: ApiProject, host: string): RepoFacts => ({
  forge: "gitlab",
  host,
  name: p.name,
  fullName: p.path_with_namespace,
  url: p.web_url,
  description: p.description || undefined,
  fork: !!p.forked_from_project,
  archived: !!p.archived,
  stars: p.star_count ?? 0,
  forks: p.forks_count ?? 0,
  openIssues: p.open_issues_count ?? 0,
  topics: p.topics ?? p.tag_list ?? [],
  license: p.license?.key,
  createdAt: p.created_at,
  pushedAt: p.last_activity_at,
  // GitLab only reports size with statistics (needs access); assume "not tiny" so scoring isn't penalised.
  sizeKb: 100,
});

/** GitLab gives languages as percentages; scale to byte-like weights comparable within a repo. */
const percentagesToWeights = (langs: Record<string, number>) =>
  Object.fromEntries(Object.entries(langs).map(([k, v]) => [k, Math.round(v * 1000)]));

export interface GitLabCollectOptions extends Omit<CollectOptions, "client"> {
  host?: string;
  client?: GitLabClient;
  /** How many projects get a languages lookup (GitLab's list has no language field). */
  languages?: number;
}

export async function collectGitLab(username: string, opts: GitLabCollectOptions = {}): Promise<GitHubData> {
  const base = gitlabBase(opts.host);
  const host = new URL(base).host;
  const cacheFile = join(CACHE_DIR, "gitlab", host, `${username.toLowerCase()}.json`);
  const cached = Bun.file(cacheFile);
  if (!opts.refresh && (await cached.exists())) {
    const data = (await cached.json()) as GitHubData;
    if (Date.now() - Date.parse(data.collectedAt) < 24 * 60 * 60 * 1000) return data;
  }

  const gl = opts.client ?? new GitLabClient(base, await gitlabToken(base));
  const progress = opts.onProgress ?? (() => {});

  progress(`GitLab profile ${username}`);
  const [found] = await gl.json<ApiUser[]>(`/users?username=${encodeURIComponent(username)}`);
  if (!found) throw new Error(`No GitLab user "${username}" on ${host}`);
  // Full profile needs a token on gitlab.com; fall back to the public summary.
  const user = await gl.json<ApiUser>(`/users/${found.id}`).catch(() => found);

  const projects: ApiProject[] = [];
  for (let page = 1; page <= 10; page++) {
    progress(`GitLab projects page ${page}`);
    const batch = await gl.json<ApiProject[]>(`/users/${found.id}/projects?per_page=100&page=${page}&order_by=last_activity_at&simple=false`);
    projects.push(...batch);
    if (batch.length < 100) break;
  }
  const repos = projects.map((p) => toFacts(p, host));
  const byPath = new Map(projects.map((p) => [p.path_with_namespace, p]));

  // Languages for the most relevant projects (one call each), so language counts mean something.
  const ranked = (opts.rank ?? detailRank)(repos.filter((r) => !r.fork));
  for (const [i, repo] of ranked.slice(0, opts.languages ?? 40).entries()) {
    progress(`GitLab languages ${i + 1}: ${repo.name}`);
    const p = byPath.get(repo.fullName)!;
    const langs = await gl.json<Record<string, number>>(`/projects/${p.id}/languages`).catch(() => ({}));
    repo.languages = percentagesToWeights(langs);
    repo.language = Object.entries(langs).sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  // README and dependency manifests for the top projects.
  for (const [i, repo] of ranked.slice(0, opts.detailed ?? 16).entries()) {
    progress(`GitLab details ${i + 1}: ${repo.name}`);
    const p = byPath.get(repo.fullName)!;
    const ref = encodeURIComponent(p.default_branch ?? "main");
    const file = (path: string) => gl.raw(`/projects/${p.id}/repository/files/${encodeURIComponent(path)}/raw?ref=${ref}`).catch(() => undefined);
    repo.readme = ((await file("README.md")) ?? (await file("README")) ?? (await file("readme.md")))?.slice(0, README_LIMIT);
    repo.manifests = {};
    const wanted = new Set(Object.keys(repo.languages ?? {}).flatMap((l) => MANIFESTS_FOR[l] ?? []));
    for (const m of wanted) {
      const body = await file(m);
      if (body) repo.manifests[m] = body.slice(0, 20_000);
    }
  }

  const data: GitHubData = {
    forge: "gitlab",
    host,
    profileUrl: user.web_url,
    user: {
      login: user.username,
      name: user.name,
      bio: user.bio || undefined,
      blog: user.website_url || undefined,
      location: user.location || undefined,
      followers: user.followers ?? 0,
      publicRepos: projects.length,
      // Unauthenticated gitlab.com hides the join date; the oldest project is a fair stand-in.
      createdAt: user.created_at ?? projects.map((p) => p.created_at).sort()[0] ?? new Date().toISOString(),
    },
    repos,
    collectedAt: new Date().toISOString(),
  };
  await Bun.write(cacheFile, JSON.stringify(data, null, 2));
  return data;
}
