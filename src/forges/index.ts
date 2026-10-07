import { collect, forgeLabel, type CollectOptions, type Forge, type GitHubClient, type GitHubData, type RepoFacts } from "../github/collect.ts";
import type { Resume } from "../schema.ts";
import { collectGitLab, DEFAULT_GITLAB_HOST, type GitLabClient } from "./gitlab.ts";

// Code hosting accounts (GitHub and GitLab) and merging their repos into one picture.

export interface Account {
  forge: Forge;
  username: string;
  /** GitLab host, e.g. "gitlab.example.com" (default gitlab.com). */
  host?: string;
}

export const accountLabel = (a: Account) => `${a.forge === "github" ? "github.com" : (a.host ?? "gitlab.com")}/${a.username}`;

/**
 * GitHub and GitLab accounts from the resume's profiles: by network name ("GitLab") or URL
 * (github.com/…, gitlab.com/…, or any host with "gitlab" in it for self-hosted).
 */
export function accountsFromResume(r: Resume): Account[] {
  const out: Account[] = [];
  for (const p of r.basics.profiles ?? []) {
    let url: URL | undefined;
    try {
      url = p.url ? new URL(p.url) : undefined;
    } catch {
      url = undefined;
    }
    const pathUser = url?.pathname.split("/").filter(Boolean)[0];
    const network = p.network?.toLowerCase() ?? "";
    if (url?.hostname.endsWith("github.com") || network === "github") {
      const username = p.username || (url?.hostname.endsWith("github.com") ? pathUser : undefined);
      if (username) out.push({ forge: "github", username });
    } else if (url?.hostname.includes("gitlab") || network.includes("gitlab")) {
      const username = p.username || pathUser;
      const host = url && url.hostname !== "gitlab.com" ? url.host : undefined;
      if (username) out.push({ forge: "gitlab", username, host });
    }
  }
  // One account per forge+host.
  return out.filter((a, i) => out.findIndex((b) => b.forge === a.forge && b.host === a.host) === i);
}

export interface CollectAccountOptions extends Omit<CollectOptions, "client"> {
  githubClient?: GitHubClient;
  gitlabClient?: GitLabClient;
}

export function collectAccount(a: Account, opts: CollectAccountOptions = {}): Promise<GitHubData> {
  if (a.forge === "github") return collect(a.username, { ...opts, client: opts.githubClient });
  return collectGitLab(a.username, { ...opts, host: a.host ?? DEFAULT_GITLAB_HOST, client: opts.gitlabClient });
}

const key = (r: RepoFacts) => r.name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Merge several accounts into one dataset. A project with the same name on two forges is treated
 * as a mirror: the more popular copy is kept (ties go to the most recent) and the other's URL is
 * recorded in `alsoOn`, so stars aren't double-counted.
 */
export function mergeData(datas: GitHubData[]): GitHubData {
  if (datas.length === 1) return datas[0]!;
  if (!datas.length) throw new Error("No accounts to merge");
  const byKey = new Map<string, RepoFacts>();
  for (const repo of datas.flatMap((d) => d.repos)) {
    const k = key(repo);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, { ...repo });
      continue;
    }
    const keepNew = repo.stars > existing.stars || (repo.stars === existing.stars && repo.pushedAt > existing.pushedAt);
    const [kept, other] = keepNew ? [{ ...repo }, existing] : [existing, repo];
    kept.alsoOn = [...new Set([...(kept.alsoOn ?? []), other.url, ...(other.alsoOn ?? [])])];
    byKey.set(k, kept);
  }
  const first = datas[0]!;
  return {
    profileUrl: first.profileUrl,
    user: {
      ...first.user,
      followers: datas.reduce((n, d) => n + d.user.followers, 0),
      publicRepos: datas.reduce((n, d) => n + d.user.publicRepos, 0),
      createdAt: datas.map((d) => d.user.createdAt).sort()[0]!,
      bio: datas.find((d) => d.user.bio)?.user.bio,
    },
    repos: [...byKey.values()],
    collectedAt: datas.map((d) => d.collectedAt).sort()[0]!,
  };
}

/** "on GitHub", "on GitLab", or "on GitHub and GitLab" for mirrored projects. */
export function whereHosted(r: RepoFacts): string {
  const others = (r.alsoOn ?? []).map((u) => (u.includes("github.com") ? "GitHub" : (() => {
    try {
      const h = new URL(u).host;
      return h === "gitlab.com" ? "GitLab" : h;
    } catch {
      return "GitLab";
    }
  })()));
  return [...new Set([forgeLabel(r), ...others])].join(" and ");
}
