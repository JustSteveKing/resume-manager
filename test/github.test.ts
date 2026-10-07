import { describe, expect, test } from "bun:test";
import { analyze, detailRank, detectTools, scoreRepo } from "../src/github/analyze.ts";
import { GitHubClient, type GitHubData, type RepoFacts } from "../src/github/collect.ts";
import { githubUsername, scanGitHub, scanReport } from "../src/github/index.ts";
import { groundSkills, isGrounded, numbersIn, toProjects, toSkills } from "../src/github/summarize.ts";
import { Resume } from "../src/schema.ts";

const NOW = Date.parse("2026-10-01T00:00:00Z");

const repo = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  name: "thing",
  fullName: "ada/thing",
  url: "https://github.com/ada/thing",
  description: "A thing",
  fork: false,
  archived: false,
  stars: 0,
  forks: 0,
  openIssues: 0,
  language: "PHP",
  topics: [],
  createdAt: "2020-01-01T00:00:00Z",
  pushedAt: "2026-06-01T00:00:00Z",
  sizeKb: 500,
  ...over,
});

const data = (repos: RepoFacts[]): GitHubData => ({
  user: { login: "ada", followers: 10, publicRepos: repos.length, createdAt: "2014-01-01T00:00:00Z" },
  repos,
  collectedAt: "2026-10-01T00:00:00Z",
});

describe("detectTools", () => {
  test("reads composer, package.json, go.mod and Cargo.toml", () => {
    const tools = detectTools(
      repo({
        manifests: {
          "composer.json": JSON.stringify({ type: "library", require: { "illuminate/support": "^11" }, "require-dev": { "pestphp/pest": "^3", "phpstan/phpstan": "^2" } }),
          "package.json": JSON.stringify({ devDependencies: { tailwindcss: "^4", "@inertiajs/vue3": "^2" } }),
          "go.mod": "module x\nrequire github.com/charmbracelet/bubbletea v1.0.0",
          "Cargo.toml": "[dependencies]\ntokio = \"1\"",
        },
      }),
    );
    expect(tools).toEqual(expect.arrayContaining(["Laravel", "Pest", "PHPStan", "PHP package development", "Tailwind CSS", "Inertia", "Bubble Tea", "Tokio"]));
  });

  test("ignores malformed manifests", () => {
    expect(detectTools(repo({ manifests: { "composer.json": "{ nope" } }))).toEqual([]);
  });
});

describe("scoreRepo", () => {
  test("rewards stars and recency, penalises forks, archives, deprecation and scratch repos", () => {
    const good = scoreRepo(repo({ stars: 400, forks: 20 }), NOW);
    expect(good.reasons).toEqual(expect.arrayContaining(["400 stars", "20 forks", "active this year"]));
    expect(scoreRepo(repo({ stars: 400, forks: 20, fork: true }), NOW).score).toBeLessThan(good.score - 9);
    expect(scoreRepo(repo({ stars: 400, archived: true }), NOW).reasons).toContain("archived");
    const frozen = scoreRepo(repo({ stars: 400, description: "Frozen. I recommend using laravel/pennant instead." }), NOW);
    expect(frozen.reasons).toContain("marked deprecated/frozen");
    expect(scoreRepo(repo({ name: "dotfiles" }), NOW).reasons).toContain("looks like a config/scratch repo");
  });
});

describe("analyze", () => {
  const repos = [
    repo({ name: "a", language: "PHP", stars: 300, topics: ["laravel", "hacktoberfest", "php"], manifests: { "composer.json": JSON.stringify({ require: { "laravel/framework": "^11" } }) } }),
    repo({ name: "b", language: "PHP", stars: 50 }),
    repo({ name: "c", language: "Go", stars: 2, topics: ["golang", "cli"] }),
    repo({ name: "d", language: "Go", stars: 1, pushedAt: "2019-01-01T00:00:00Z" }),
    repo({ name: "e", language: "Go", stars: 0 }),
    repo({ name: "f", language: "HTML" }),
    repo({ name: "forked", language: "Rust", fork: true, stars: 999 }),
  ];
  const a = analyze(data(repos), { now: NOW });

  test("languages need 2+ repos, weighted by recency; forks ignored", () => {
    expect(a.languages.map((l) => l.name)).toEqual(["Go", "PHP"]);
    expect(a.languages.find((l) => l.name === "Go")).toMatchObject({ repos: 3, weight: 2.4 });
  });

  test("topics: noise dropped, languages dropped, aliases folded into detected tools", () => {
    const names = a.tools.map((t) => t.name);
    expect(names).toContain("Laravel");
    expect(names).toContain("cli");
    expect(names).not.toContain("hacktoberfest");
    expect(names).not.toContain("golang");
    expect(names).not.toContain("laravel");
    expect(a.tools.find((t) => t.name === "Laravel")?.source).toBe("dependency");
  });

  test("stats count originals only", () => {
    expect(a.stats).toMatchObject({ originals: 6, forks: 1, stars: 353 });
  });

  test("detailRank keeps the best Go repos even when PHP has more stars", () => {
    const many = [...Array.from({ length: 10 }, (_, i) => repo({ name: `php${i}`, stars: 100 + i })), ...repos.slice(2, 5)];
    expect(detailRank(many, NOW).slice(0, 8).map((r) => r.name)).toEqual(expect.arrayContaining(["c", "e"]));
  });
});

describe("grounding", () => {
  test("numbersIn normalises separators and k/m suffixes", () => {
    expect(numbersIn("2,932 stars, 1.2k users, 3m rows, PHP 8")).toEqual([2932, 1200, 3_000_000, 8]);
  });

  test("claims need every number in the facts", () => {
    const facts = "stars: 1234; forks: 24; created: 2021";
    expect(isGrounded("Over 1.2k stars", facts)).toBe(true);
    expect(isGrounded("24 forks since 2021", facts)).toBe(true);
    expect(isGrounded("Used by 10,000 developers", facts)).toBe(false);
    expect(isGrounded("No numbers at all", facts)).toBe(true);
  });

  const a = analyze(data([repo({ name: "http-client", url: "https://github.com/ada/http-client", stars: 412, forks: 24, topics: ["hacktoberfest", "laravel"], readme: "Send API requests the OOP way." })]), { now: NOW });

  test("toProjects drops stat-only and invented bullets, adds one accurate popularity line", () => {
    const [p] = toProjects(a, [
      {
        repo: "http-client",
        description: "Object-oriented API requests for Laravel.",
        highlights: ["Used by 412 stars", "Has 24 forks", "Developed in 2021", "Wraps PendingRequest in reusable request classes", "Trusted by 10,000 teams"],
        keywords: ["laravel", "Laravel", "hacktoberfest", "HTTP"],
        roles: ["Creator"],
      },
    ]);
    expect(p!.project.highlights).toEqual(["Wraps PendingRequest in reusable request classes", "412 stars and 24 forks on GitHub"]);
    expect(p!.dropped).toEqual(["Trusted by 10,000 teams"]);
    expect(p!.project.keywords).toEqual(["PHP", "Laravel", "HTTP"]);
    expect(p!.project).toMatchObject({ url: "https://github.com/ada/http-client", startDate: "2020-01", roles: ["Creator"] });
  });

  test("toProjects falls back to repo facts when there is no write-up", () => {
    const [p] = toProjects(a);
    expect(p!.project.description).toBe("A thing");
    expect(p!.project.highlights).toEqual(["412 stars and 24 forks on GitHub"]);
  });

  test("toSkills removes project names and non-skill groups", () => {
    const skills = toSkills(
      a,
      {
        summary: "PHP engineer.",
        skills: [
          { name: "APIs & Architecture", keywords: ["REST APIs", "Http Client", "SDK design"], evidence: "" },
          { name: "Notable Projects", keywords: ["http-client"], evidence: "" },
        ],
      },
      ["http-client"],
    );
    expect(skills).toEqual([{ name: "APIs & Architecture", keywords: ["REST APIs", "SDK design"] }]);
  });

  test("groundSkills strips invented numbers from evidence and summary", () => {
    const g = groundSkills(
      { summary: "PHP engineer. Shipped 40 packages. Focused on APIs.", skills: [{ name: "Languages", keywords: ["PHP"], evidence: "PHP in 115 repos" }] },
      "PHP: 115 repos",
    );
    expect(g.summary).toBe("PHP engineer. Focused on APIs.");
    expect(g.skills[0]!.evidence).toBe("PHP in 115 repos");
  });
});

test("githubUsername reads the GitHub profile", () => {
  const r = Resume.parse({ basics: { profiles: [{ network: "Twitter", url: "https://twitter.com/x" }, { network: "GitHub", url: "https://github.com/AdaDev/" }] } });
  expect(githubUsername(r)).toBe("AdaDev");
  expect(githubUsername(Resume.parse({}))).toBeUndefined();
});

describe("scanGitHub (offline)", () => {
  class FakeGitHub extends GitHubClient {
    paths: string[] = [];
    override async json<T>(path: string): Promise<T> {
      this.paths.push(path);
      if (path === "/users/ada") return { login: "ada", name: "Ada", bio: "APIs", blog: "", company: null, location: null, followers: 5, public_repos: 2, created_at: "2015-01-01T00:00:00Z" } as T;
      if (path.startsWith("/users/ada/repos")) {
        return [
          { name: "sdk", full_name: "ada/sdk", html_url: "https://github.com/ada/sdk", description: "SDK builder", homepage: null, fork: false, archived: false, stargazers_count: 217, forks_count: 14, open_issues_count: 0, language: "PHP", topics: ["api"], license: { spdx_id: "MIT" }, created_at: "2020-03-01T00:00:00Z", pushed_at: "2026-05-01T00:00:00Z", size: 400, owner: { login: "ada" } },
          { name: "fork", full_name: "ada/fork", html_url: "https://github.com/ada/fork", description: null, homepage: null, fork: true, archived: false, stargazers_count: 0, forks_count: 0, open_issues_count: 0, language: "Go", topics: [], license: null, created_at: "2020-03-01T00:00:00Z", pushed_at: "2020-05-01T00:00:00Z", size: 10, owner: { login: "ada" } },
        ] as T;
      }
      if (path.endsWith("/languages")) return { PHP: 9000, Shell: 100 } as T;
      throw new Error(`unexpected ${path}`);
    }
    override async raw(path: string) {
      this.paths.push(path);
      if (path.endsWith("/readme")) return "# SDK\nBuild API SDKs with a clean base client.";
      if (path.endsWith("composer.json")) return JSON.stringify({ type: "library", require: { "saloonphp/saloon": "^3" } });
      return undefined;
    }
  }

  test("collects, analyses, writes grounded copy and a report", async () => {
    const gh = new FakeGitHub();
    const prompts: string[] = [];
    const generate = async (p: { instructions: string }) => {
      prompts.push(p.instructions);
      return prompts.length === 1
        ? { summary: "PHP engineer building API SDKs.", skills: [{ name: "Frameworks", keywords: ["Saloon", "sdk"], evidence: "Saloon in 1 repo" }] }
        : { projects: [{ repo: "sdk", description: "Build typed API SDKs fast.", highlights: ["Clean base client with resource traits", "Has 217 stars"], keywords: ["Saloon"], roles: ["Creator"] }] };
    };
    const scan = await scanGitHub({ username: "ada", ai: true, refresh: true, client: gh, generate });

    expect(gh.paths).not.toContain("/repos/ada/fork/languages"); // forks get no detail pass
    expect(prompts[0]).toContain("Saloon: 1 repos");
    expect(prompts[1]).toContain("README excerpt:\n# SDK");
    expect(prompts.every((p) => p.length <= 20_000)).toBe(true);
    expect(scan.skills).toEqual([{ name: "Frameworks", keywords: ["Saloon"] }]);
    expect(scan.projects[0]!.project).toMatchObject({
      name: "sdk",
      description: "Build typed API SDKs fast.",
      highlights: ["Clean base client with resource traits", "217 stars and 14 forks on GitHub"],
      keywords: ["PHP", "Saloon", "PHP package development"],
    });
    const report = scanReport(scan);
    expect(report).toContain("## Summary\n\nPHP engineer building API SDKs.");
    expect(report).toContain("| Saloon | 1 | dependency |");
  });
});
