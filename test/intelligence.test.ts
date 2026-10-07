import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftBullets, interviewQuestions, rewrite, rolesNeedingWork, templateQuestions } from "../src/ai/coach.ts";
import { cached } from "../src/ai/index.ts";
import { fakeAI } from "./fixtures.ts";
import { interviewPrep, prepMarkdown } from "../src/ai/prep.ts";
import { ensureApplication, followUpsDue, learn, listApplications, setStatus, APPLICATIONS_DIR } from "../src/applications.ts";
import { consistency } from "../src/consistency.ts";
import { lint, overlap } from "../src/lint.ts";
import { evidenceMap, skillForms, stem, supports } from "../src/evidence.ts";
import { firstGlance } from "../src/export/ats.ts";
import { PdfRenderer } from "../src/export/index.ts";
import { THEMES } from "../src/export/themes.ts";
import type { RepoAnalysis } from "../src/repos/analyze.ts";
import { GitHubClient } from "../src/forges/github.ts";
import { applySuggestion, loadSuggestions, resolveSuggestion, runInbox } from "../src/inbox.ts";
import { toResume } from "../src/importer.ts";
import { linkedInToJsonResume, parseCsv, renderLinkedIn, splitDescription } from "../src/linkedin.ts";
import { Resume, type Work } from "../src/schema.ts";
import { load } from "../src/store.ts";
import { applyVariant } from "../src/variants.ts";

const role: Work = {
  name: "Acme Corp",
  position: "Lead Engineer",
  startDate: "2022-03",
  endDate: "2024-01",
  summary: "Led the platform team.",
  highlights: ["Cut deploy time from 40 minutes to 8", "Ran hiring"],
};

describe("writing coach", () => {
  test("keeps grounded rewrites, drops invented numbers and duplicates, strips bullets", async () => {
    const ai = fakeAI({
      options: [
        { style: "shorter", text: "• Cut deploys from 40 to 8 minutes" },
        { style: "result", text: "Saved 32 minutes per deploy by rebuilding CI" }, // 32 isn't in the facts
        { style: "xyz", text: "Cut deploy time 40→8 minutes by rebuilding the pipeline" },
        { style: "xyz", text: "duplicate style" },
      ],
    });
    const out = await rewrite(ai, role.highlights![0]!, "highlight", role);
    expect(out.map((o) => o.style)).toEqual(["shorter", "xyz"]);
    expect(out[0]!.text).toBe("Cut deploys from 40 to 8 minutes");
    expect(ai.prompts[0]).toContain("Role: Lead Engineer at Acme Corp");
  });

  test("cached() serves repeat requests without calling the model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rm-ai-cache-"));
    const inner = fakeAI({ options: [{ style: "shorter", text: "Short" }] });
    const ai = cached(inner, dir);
    await rewrite(ai, "Some text", "highlight");
    await rewrite(ai, "Some text", "highlight");
    expect(inner.prompts).toHaveLength(1);
  });
});

describe("achievement interviewer", () => {
  test("falls back to template questions without AI", async () => {
    const qs = await interviewQuestions(undefined, role);
    expect(qs).toEqual(templateQuestions(role));
    expect(qs[0]!.question).toContain("Cut deploy time");
  });

  test("uses AI questions when available", async () => {
    const qs = await interviewQuestions(fakeAI({ questions: [{ question: "How many services?", why: "scale" }] }), role);
    expect(qs).toEqual([{ question: "How many services?", why: "scale" }]);
  });

  test("bullets may use numbers from answers, not invented ones; skips existing highlights", async () => {
    const ai = fakeAI({ bullets: ["Grew the team from 3 to 9 engineers", "Ran hiring", "Saved £2m a year", "- Hired 6 engineers in 2023"] });
    const res = await draftBullets(ai, role, [{ question: "Team size?", answer: "went from 3 to 9, hired 6 in 2023" }, { question: "Other?", answer: "" }]);
    expect(res.bullets).toEqual(["Grew the team from 3 to 9 engineers", "Hired 6 engineers in 2023"]);
    expect(res.dropped).toEqual(["Saved £2m a year"]);
    expect(ai.prompts[0]).not.toContain("Other?");
  });

  test("no answers means no model call", async () => {
    const ai = fakeAI({ bullets: ["x"] });
    expect(await draftBullets(ai, role, [{ question: "Q", answer: "  " }])).toEqual({ bullets: [], dropped: [] });
    expect(ai.prompts).toHaveLength(0);
  });

  test("rolesNeedingWork flags missing numbers and long summaries", () => {
    const r = Resume.parse({ work: [{ name: "A", highlights: ["Did things", "More things"] }, { name: "B", highlights: ["Grew 20%"] }, { name: "C", summary: "word ".repeat(45) }] });
    expect(rolesNeedingWork(r)).toEqual([
      { index: 0, reasons: ["no numbers"] },
      { index: 1, reasons: ["only one highlight"] },
      { index: 2, reasons: ["no highlights", "long summary"] },
    ]);
  });
});

describe("evidence", () => {
  test("stems and loose matching", () => {
    expect(stem("Writing")).toBe(stem("writer"));
    expect(stem("spoke")).toBe(stem("speaking"));
    expect(stem("conferences")).toBe(stem("conference"));
    expect(supports("Technical Writer for Example Weekly", "Technical Writing")).toBe(true);
    expect(supports("Spoke at 15+ global conferences", "Conference Speaking")).toBe(true);
    expect(supports("Going to market", "Go")).toBe(false);
  });

  test("skillForms strips versions, .js, and expands brackets", () => {
    expect(skillForms("Laravel 11")).toEqual(["Laravel 11", "Laravel"]);
    expect(skillForms("Vue.js")).toEqual(["Vue.js", "Vue"]);
    expect(skillForms("Domain-Driven Design (DDD)")).toEqual(["Domain-Driven Design (DDD)", "Domain-Driven Design", "DDD"]);
  });

  test("statuses: strong, unsupported, stale, unlisted; GitHub counts as proof", () => {
    const r = Resume.parse({
      work: [
        { name: "A", position: "Engineer", startDate: "2023-01", highlights: ["Built Laravel APIs", "Laravel queues at scale"] },
        { name: "B", position: "Dev", startDate: "2010-01", endDate: "2012-01", highlights: ["Wrote Perl scripts"] },
      ],
      projects: [{ name: "pkg", keywords: ["Laravel"] }],
      publications: [{ name: "Laravel tips", releaseDate: "2024-01" }],
      skills: [{ name: "Backend", keywords: ["Laravel 11", "Redis", "Perl", "Go"] }],
    });
    const gh = { languages: [{ name: "Go", repos: 5, weight: 5, share: 0, lastUsed: "2026-01-01T00:00:00Z" }], tools: [], portfolio: [], login: "x", stats: {} } as unknown as RepoAnalysis;
    const m = Object.fromEntries(evidenceMap(r, gh, new Date("2026-06-01")).map((e) => [e.skill, e.status]));
    expect(m).toMatchObject({ "Laravel 11": "strong", Redis: "unsupported", Perl: "stale", Go: "weak" });
    expect(m.Laravel).toBeUndefined(); // listed as "Laravel 11", so not "unlisted"
  });
});

describe("consistency", () => {
  test("tense, spelling, gaps and title variants", () => {
    const r = Resume.parse({
      basics: { summary: "Optimised pipelines and organized teams." },
      work: [
        { name: "New", position: "Tech Lead", startDate: "2020-01", highlights: ["Lead the team"] },
        { name: "Old", position: "Technical Lead", startDate: "2015-01", endDate: "2018-06", highlights: ["Manage releases", "Shipped v2"] },
      ],
    });
    const msgs = consistency(r, new Date("2026-01-01")).map((f) => f.message);
    expect(msgs.some((m) => m.includes('present tense on a finished role (try "Managed")'))).toBe(true);
    expect(msgs.some((m) => m.includes("Lead the team"))).toBe(false); // current role: present tense is fine
    expect(msgs.some((m) => m.startsWith("Mixed British and American spelling"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("19-month gap between Old and New"))).toBe(true);
    expect(msgs.some((m) => m.includes('"Tech Lead" and "Technical Lead"'))).toBe(true);
  });
});

describe("applications", () => {
  test("track status, follow-ups, adopt old job.md folders, learn what works", async () => {
    await mkdir(join(APPLICATIONS_DIR, "old-job"), { recursive: true });
    await Bun.write(join(APPLICATIONS_DIR, "old-job", "job.md"), "# Dev @ Oldco\n\nSource: https://x.test/1\n\n## Keyword coverage: 40%\n");
    const variants = ["devrel", "devrel", "devrel", "general", "general", "general"];
    for (const [i, v] of variants.entries()) await ensureApplication({ slug: `job-${i}`, company: `Co ${i}`, variant: v, coverage: i < 3 ? 0.8 : 0.4 });
    // Other suites share the temp applications folder; only look at this test's records.
    const mine = (list: Awaited<ReturnType<typeof listApplications>>) => list.filter((a) => a.slug === "old-job" || a.slug.startsWith("job-"));
    let apps = mine(await listApplications());
    expect(apps.find((a) => a.slug === "old-job")).toMatchObject({ status: "draft", coverage: 0.4, url: "https://x.test/1" });

    for (const a of apps.filter((x) => x.slug.startsWith("job-"))) {
      const sentApp = await setStatus(a, "applied", "2026-01-01");
      expect(sentApp.followUp).toBe("2026-01-08");
      if (a.variant === "devrel" && a.slug !== "job-2") await setStatus(sentApp, "interview", "2026-01-05");
    }
    apps = mine(await listApplications());
    expect(followUpsDue(apps, "2026-01-10").map((a) => a.slug).sort()).toEqual(["job-0", "job-1", "job-2", "job-3", "job-4", "job-5"]);
    const l = await learn(apps);
    expect(l).toMatchObject({ sent: 6, responses: 2 });
    expect(l.byVariant[0]).toMatchObject({ key: "devrel", sent: 3, responses: 2 });
    expect(l.insights[0]).toContain('"devrel" gets responses 67%');
  });
});

describe("interview prep", () => {
  test("real evidence is kept; invented evidence becomes a gap", async () => {
    const r = Resume.parse({ work: [role] });
    const ai = fakeAI({
      questions: [
        { question: "How do you speed up delivery?", why: "CI/CD", evidence: ["Cut deploy time from 40 minutes to 8"], talkingPoints: ["Pipeline rebuild"] },
        { question: "Tell us about Kubernetes", why: "Infra", evidence: ["Ran 300 k8s clusters"], talkingPoints: ["invented"] },
      ],
    });
    const qs = await interviewPrep(ai, r, { title: "Platform Lead", requirements: ["CI/CD", "Kubernetes"] });
    expect(qs[0]).toMatchObject({ gap: false, evidence: ["Cut deploy time from 40 minutes to 8"] });
    expect(qs[1]).toMatchObject({ gap: true, evidence: [], talkingPoints: [] });
    expect(prepMarkdown({ title: "Platform Lead" }, qs)).toContain("1 question(s) with no evidence");
  });
});

describe("inbox", () => {
  class FakeGitHub extends GitHubClient {
    stars = 90;
    repos = ["http-kit"];
    override async json<T>(path: string): Promise<T> {
      if (path === "/users/ada") return { login: "ada", name: null, bio: null, blog: null, company: null, location: null, followers: 1, public_repos: 1, created_at: "2015-01-01T00:00:00Z" } as T;
      if (path.startsWith("/users/ada/repos")) {
        return this.repos.map((name) => ({
          name, full_name: `ada/${name}`, html_url: `https://github.com/ada/${name}`, description: `${name} does things`, homepage: null, fork: false, archived: false,
          stargazers_count: name === "http-kit" ? this.stars : 40, forks_count: 3, open_issues_count: 0, language: "PHP", topics: [], license: null,
          created_at: "2024-01-01T00:00:00Z", pushed_at: new Date().toISOString(), size: 900, owner: { login: "ada" },
        })) as T;
      }
      if (path.endsWith("/languages")) return { PHP: 100 } as T;
      throw new Error(path);
    }
    override async raw() {
      return undefined;
    }
  }

  test("baseline first, then milestones and new repos; accept and dismiss", async () => {
    const r = Resume.parse({
      basics: { profiles: [{ network: "GitHub", url: "https://github.com/ada" }] },
      projects: [{ name: "http-kit", url: "https://github.com/ada/http-kit", highlights: ["Typed HTTP client", "90 stars and 3 forks on GitHub"] }],
    });
    const gh = new FakeGitHub();
    const first = await runInbox(r, { client: gh });
    expect(first).toMatchObject({ baseline: true, added: [] });

    gh.stars = 130;
    gh.repos.push("new-tool");
    const second = await runInbox(r, { client: gh });
    expect(second.added.map((s) => s.title).sort()).toEqual(["New repo: new-tool", "http-kit passed 100 stars"]);

    const milestone = second.added.find((s) => s.title.includes("passed"))!;
    applySuggestion(r, milestone);
    expect(r.projects[0]!.highlights).toEqual(["Typed HTTP client", "130 stars and 3 forks on GitHub"]);

    const repo = second.added.find((s) => s.title.startsWith("New repo"))!;
    await resolveSuggestion(repo.id, true);
    await resolveSuggestion(milestone.id, false);
    expect(await loadSuggestions()).toEqual([]);
    expect((await runInbox(r, { client: gh })).added).toEqual([]); // dismissed stays dismissed
  });
});

describe("LinkedIn", () => {
  test("parseCsv: BOM, preamble, quotes, commas and newlines in fields", () => {
    const csv = '﻿Notes:\n"Exported"\n\nCompany Name,Title,Description\n"Acme, Inc",Lead,"Line one\n• Built ""things"""\n';
    expect(parseCsv(csv)).toEqual([{ "Company Name": "Acme, Inc", Title: "Lead", Description: 'Line one\n• Built "things"' }]);
  });

  test("splitDescription turns bullets into highlights", () => {
    expect(splitDescription("Owned the API.\n• Cut latency 40%\n- Hired 5")).toEqual({ summary: "Owned the API.", highlights: ["Cut latency 40%", "Hired 5"] });
  });

  test("export folder → JSON Resume via the normal importer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rm-linkedin-"));
    await Bun.write(join(dir, "Profile.csv"), "First Name,Last Name,Headline,Summary,Geo Location,Websites\nGrace,Example,Staff Engineer,Builds APIs.,Bristol,[PERSONAL:https://grace.example]\n");
    await Bun.write(join(dir, "Email Addresses.csv"), "Email Address,Confirmed,Primary\ng@example.com,Yes,Yes\n");
    await Bun.write(join(dir, "Positions.csv"), 'Company Name,Title,Description,Location,Started On,Finished On\nAcme,Staff Engineer,"Platform lead.\n• Cut costs 30%",Remote,Mar 2021,\nWidgets,Engineer,,London,Sep 2017,Feb 2021\n');
    await Bun.write(join(dir, "Skills.csv"), "Name\nPHP\nGo\n");
    const report = toResume("linkedin", await linkedInToJsonResume(dir));
    expect(report.invalid).toEqual([]);
    expect(report.resume.basics).toMatchObject({ name: "Grace Example", label: "Staff Engineer", email: "g@example.com", url: "https://grace.example", location: { city: "Bristol" } });
    expect(report.resume.work[0]).toMatchObject({ name: "Acme", startDate: "2021-03", summary: "Platform lead.", highlights: ["Cut costs 30%"] });
    expect(report.resume.work[0]!.endDate).toBeUndefined();
    expect(report.resume.skills).toEqual([{ name: "LinkedIn skills", keywords: ["PHP", "Go"] }]);
  });

  test("renderLinkedIn counts characters and flags overflow", async () => {
    const r = await load("examples/resume.example.json");
    r.basics.label = "x".repeat(230);
    const md = renderLinkedIn(applyVariant(r));
    expect(md).toContain("## Headline (230/220) ⚠ 10 over, trimmed");
    expect(md).toContain("#### Description (");
  });
});

describe("first glance (renders a PDF)", () => {
  const renderer = new PdfRenderer();
  afterAll(() => renderer.close());

  test("reports what the top third shows and warns on a long summary", async () => {
    const r = await load("examples/resume.example.json");
    let view = applyVariant(r);
    const glance = await firstGlance(await renderer.render(view, THEMES[0]!, "A4"), view);
    expect(glance.shows).toEqual(expect.arrayContaining(["name", "headline", "contact"]));
    expect(glance.firstRole).toBe("Senior Backend Engineer @ Acme Corp");
    expect(glance.warnings).toEqual([]);

    r.basics.summary = "Engineer who builds things. ".repeat(18);
    view = applyVariant(r);
    const long = await firstGlance(await renderer.render(view, THEMES[0]!, "A4"), view);
    expect(long.warnings.some((w) => w.startsWith("Summary is 72 words"))).toBe(true);
  }, 30_000);
});

describe("near-duplicate highlights", () => {
  test("flags rewrites left next to their originals, not merely related bullets", () => {
    expect(overlap("Cut build and release times and sharply reduce failed deployments by introducing standardised controls across the CI/CD pipeline", "Shorten build and release times and sharply reduce failed deployments by reworking CI/CD pipelines and introducing standardised release controls")).toBeGreaterThanOrEqual(0.6);
    expect(overlap("Lead and mentor a team of 10 engineers as fractional CTO, guiding hiring, roadmap planning and product direction", "Guide hiring, roadmap planning and product direction as fractional CTO, mentoring a team of 10 engineers")).toBeGreaterThanOrEqual(0.6);
    expect(overlap("Designed the public API", "Mentored two junior engineers")).toBeLessThan(0.6);
    const r = Resume.parse({
      skills: [{ name: "x" }],
      work: [{ name: "Acme", position: "Lead", startDate: "2020", highlights: ["Cut release times by reworking the CI/CD pipeline", "Shorten release times by reworking CI/CD pipelines", "Hired 4 engineers"] }],
    });
    const msgs = lint(r).map((i) => i.message).filter((m) => m.includes("say nearly the same thing"));
    expect(msgs).toHaveLength(1);
  });
});
