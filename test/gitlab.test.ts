import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runDoctor } from "../src/doctor.ts";
import { accountLabel, accountsFromResume, mergeData, whereHosted } from "../src/forges/index.ts";
import { collectGitLab, gitlabBase, GitLabClient } from "../src/forges/gitlab.ts";
import { CACHE_DIR, forgeLabel, GitHubClient, type GitHubData, type RepoFacts } from "../src/github/collect.ts";
import { scanRepos, scanReport } from "../src/github/index.ts";
import { popularity } from "../src/github/summarize.ts";
import { applySuggestion, runInbox } from "../src/inbox.ts";
import { Resume } from "../src/schema.ts";

/** Fake GitLab API: unauthenticated-style responses (user detail forbidden, percent languages). */
class FakeGitLab extends GitLabClient {
  paths: string[] = [];
  stars = 30;
  constructor(base = "https://gitlab.com") {
    super(base);
  }
  override async json<T>(path: string): Promise<T> {
    this.paths.push(path);
    if (path.startsWith("/users?username=grace")) return [{ id: 7, username: "grace", name: "Grace", web_url: `${this.base}/grace` }] as T;
    if (path.startsWith("/users?username=")) return [] as T;
    if (path === "/users/7") throw new Error("GitLab 403 for /users/7");
    if (path.startsWith("/users/7/projects")) {
      return [
        { id: 1, name: "http-kit", path_with_namespace: "grace/http-kit", web_url: `${this.base}/grace/http-kit`, description: "Typed HTTP client", star_count: this.stars, forks_count: 2, tag_list: ["php", "http"], created_at: "2022-01-01T00:00:00Z", last_activity_at: new Date().toISOString(), default_branch: "main" },
        { id: 2, name: "forked-thing", path_with_namespace: "grace/forked-thing", web_url: `${this.base}/grace/forked-thing`, description: null, star_count: 0, forks_count: 0, topics: [], created_at: "2023-01-01T00:00:00Z", last_activity_at: "2023-02-01T00:00:00Z", forked_from_project: { id: 99 } },
        { id: 3, name: "go-tool", path_with_namespace: "grace/go-tool", web_url: `${this.base}/grace/go-tool`, description: "CLI in Go", star_count: 5, forks_count: 1, topics: ["cli"], created_at: "2024-01-01T00:00:00Z", last_activity_at: new Date().toISOString(), default_branch: "trunk", archived: true },
      ] as T;
    }
    if (path === "/projects/1/languages") return { PHP: 91.5, JavaScript: 8.5 } as T;
    if (path === "/projects/3/languages") return { Go: 100 } as T;
    if (path.endsWith("/languages")) return {} as T;
    throw new Error(`unexpected ${path}`);
  }
  override async raw(path: string) {
    this.paths.push(path);
    if (path === "/projects/1/repository/files/README.md/raw?ref=main") return "# http-kit\nTyped requests for Laravel.";
    if (path === "/projects/1/repository/files/composer.json/raw?ref=main") return JSON.stringify({ type: "library", require: { "illuminate/support": "^11" } });
    if (path === "/projects/3/repository/files/go.mod/raw?ref=trunk") return "module x\nrequire github.com/spf13/cobra v1.8.0";
    return undefined;
  }
}

describe("GitLab collector", () => {
  test("maps projects, percentages, forks, archives, READMEs and manifests", async () => {
    const gl = new FakeGitLab();
    const data = await collectGitLab("grace", { client: gl, refresh: true });
    expect(data).toMatchObject({ forge: "gitlab", host: "gitlab.com", profileUrl: "https://gitlab.com/grace", user: { login: "grace", name: "Grace" } });
    const kit = data.repos.find((r) => r.name === "http-kit")!;
    expect(kit).toMatchObject({ forge: "gitlab", fork: false, archived: false, stars: 30, topics: ["php", "http"], language: "PHP" });
    expect(kit.languages).toEqual({ PHP: 91500, JavaScript: 8500 });
    expect(kit.readme).toContain("Typed requests");
    // Manifests are looked up per language (PHP → composer.json, JavaScript → package.json); only existing ones are kept.
    expect(gl.paths).toContain("/projects/1/repository/files/package.json/raw?ref=main");
    expect(Object.keys(kit.manifests ?? {})).toEqual(["composer.json"]);
    expect(data.repos.find((r) => r.name === "forked-thing")?.fork).toBe(true);
    expect(data.repos.find((r) => r.name === "go-tool")).toMatchObject({ archived: true, language: "Go" });
    // Forks get no languages/details lookup; the default branch is respected.
    expect(gl.paths).not.toContain("/projects/2/languages");
    expect(gl.paths).toContain("/projects/3/repository/files/go.mod/raw?ref=trunk");
    expect(await Bun.file(join(CACHE_DIR, "gitlab", "gitlab.com", "grace.json")).exists()).toBe(true);
  });

  test("self-hosted host, unknown user", async () => {
    expect(gitlabBase("gitlab.example.com/")).toBe("https://gitlab.example.com");
    const data = await collectGitLab("grace", { client: new FakeGitLab("https://gitlab.example.com"), host: "gitlab.example.com", refresh: true });
    expect(data.host).toBe("gitlab.example.com");
    expect(forgeLabel(data.repos[0]!)).toBe("gitlab.example.com");
    expect(collectGitLab("nobody", { client: new FakeGitLab(), refresh: true })).rejects.toThrow('No GitLab user "nobody"');
  });
});

describe("accounts and merging", () => {
  test("accountsFromResume finds GitHub, gitlab.com and self-hosted GitLab", () => {
    const r = Resume.parse({
      basics: {
        profiles: [
          { network: "GitHub", url: "https://github.com/ada" },
          { network: "GitLab", url: "https://gitlab.com/ada-gl" },
          { network: "Work GitLab", url: "https://gitlab.acme.dev/ada.l" },
          { network: "Twitter", url: "https://twitter.com/ada" },
        ],
      },
    });
    const accounts = accountsFromResume(r);
    expect(accounts).toEqual([
      { forge: "github", username: "ada" },
      { forge: "gitlab", username: "ada-gl", host: undefined },
      { forge: "gitlab", username: "ada.l", host: "gitlab.acme.dev" },
    ]);
    expect(accounts.map(accountLabel)).toEqual(["github.com/ada", "gitlab.com/ada-gl", "gitlab.acme.dev/ada.l"]);
  });

  const repo = (o: Partial<RepoFacts>): RepoFacts => ({
    name: "x", fullName: "a/x", url: "u", fork: false, archived: false, stars: 0, forks: 0, openIssues: 0, topics: [],
    createdAt: "2020-01-01T00:00:00Z", pushedAt: "2025-01-01T00:00:00Z", sizeKb: 100, ...o,
  });
  const data = (forge: "github" | "gitlab", repos: RepoFacts[]): GitHubData => ({
    forge, user: { login: "ada", followers: 3, publicRepos: repos.length, createdAt: forge === "github" ? "2014-01-01" : "2012-01-01" }, repos, collectedAt: "2026-01-01",
  });

  test("mirrors count once: the more popular copy is kept, the other noted", () => {
    const merged = mergeData([
      data("github", [repo({ name: "http-kit", forge: "github", url: "https://github.com/ada/http-kit", stars: 400 }), repo({ name: "only-gh", forge: "github" })]),
      data("gitlab", [repo({ name: "HTTP-Kit", forge: "gitlab", url: "https://gitlab.com/ada/http-kit", stars: 12 }), repo({ name: "only-gl", forge: "gitlab" })]),
    ]);
    expect(merged.repos.map((r) => r.name).sort()).toEqual(["http-kit", "only-gh", "only-gl"]);
    const kit = merged.repos.find((r) => r.name === "http-kit")!;
    expect(kit).toMatchObject({ forge: "github", stars: 400, alsoOn: ["https://gitlab.com/ada/http-kit"] });
    expect(whereHosted(kit)).toBe("GitHub and GitLab");
    expect(merged.user).toMatchObject({ followers: 6, createdAt: "2012-01-01" });
  });

  test("popularity names the forge the counts came from", () => {
    expect(popularity({ stars: 12, forks: 1, forge: "gitlab" })).toBe("12 stars and 1 fork on GitLab");
    expect(popularity({ stars: 1, forks: 0, forge: "gitlab", host: "gitlab.acme.dev" })).toBe("1 star and 0 forks on gitlab.acme.dev");
    expect(popularity({ stars: 0, forks: 0 })).toBeUndefined();
  });
});

describe("combined scan", () => {
  class FakeGitHub extends GitHubClient {
    override async json<T>(path: string): Promise<T> {
      if (path === "/users/ada") return { login: "ada", name: "Ada", bio: null, blog: null, company: null, location: null, followers: 9, public_repos: 1, created_at: "2015-01-01T00:00:00Z" } as T;
      if (path.startsWith("/users/ada/repos")) {
        return [{ name: "http-kit", full_name: "ada/http-kit", html_url: "https://github.com/ada/http-kit", description: "Mirror", homepage: null, fork: false, archived: false, stargazers_count: 3, forks_count: 0, open_issues_count: 0, language: "PHP", topics: [], license: null, created_at: "2022-01-01T00:00:00Z", pushed_at: "2024-01-01T00:00:00Z", size: 200, owner: { login: "ada" } }] as T;
      }
      if (path.endsWith("/languages")) return { PHP: 1000 } as T;
      throw new Error(path);
    }
    override async raw() {
      return undefined;
    }
  }

  test("GitHub + GitLab: merged, reported, and written up with the right forge", async () => {
    const scan = await scanRepos({
      accounts: [{ forge: "github", username: "ada" }, { forge: "gitlab", username: "grace" }],
      refresh: true,
      client: new FakeGitHub(),
      gitlabClient: new FakeGitLab(),
    });
    // http-kit: GitLab copy (30★) beats the GitHub mirror (3★).
    const kit = scan.data.repos.find((r) => r.name === "http-kit")!;
    expect(kit).toMatchObject({ forge: "gitlab", stars: 30, alsoOn: ["https://github.com/ada/http-kit"] });
    expect(scan.projects.find((p) => p.project.name === "http-kit")?.project.highlights).toContain("30 stars and 2 forks on GitLab");
    const report = scanReport(scan);
    expect(report).toContain("# Repositories: github.com/ada · gitlab.com/grace");
    expect(report).toContain("also on https://github.com/ada/http-kit");
    expect(scan.analysis.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["Laravel", "Cobra"]));
  });
});

describe("inbox with GitLab", () => {
  test("each account gets its own baseline; GitLab milestones update the GitLab line", async () => {
    const r = Resume.parse({
      basics: { profiles: [{ network: "GitLab", url: "https://gitlab.com/grace" }] },
      projects: [{ name: "http-kit", url: "https://gitlab.com/grace/http-kit", highlights: ["30 stars and 2 forks on GitLab"] }],
    });
    const gl = new FakeGitLab();
    expect((await runInbox(r, { gitlabClient: gl, sources: false })).baseline).toBe(true);
    gl.stars = 60;
    const second = await runInbox(r, { gitlabClient: gl, sources: false });
    const milestone = second.added.find((s) => s.title === "http-kit passed 50 stars")!;
    expect(milestone.id).toBe("stars:gitlab:gitlab.com:http-kit:50");
    applySuggestion(r, milestone);
    expect(r.projects[0]!.highlights).toEqual(["60 stars and 2 forks on GitLab"]);
  });
});

describe("doctor", () => {
  test("reports GitLab as not set up when there's no profile or token", async () => {
    const saved = process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    try {
      const gitlab = (await runDoctor()).find((c) => c.id === "gitlab");
      expect(gitlab).toBeDefined();
      expect(["info", "ok", "warn"]).toContain(gitlab!.status);
    } finally {
      if (saved) process.env.GITLAB_TOKEN = saved;
    }
  });
});
