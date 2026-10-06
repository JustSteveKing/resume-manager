import { afterAll, describe, expect, test } from "bun:test";
import { checkAts } from "../src/export/ats.ts";
import { renderHtml } from "../src/export/html.ts";
import { PdfRenderer } from "../src/export/index.ts";
import { renderText } from "../src/export/text.ts";
import { THEMES, type Theme } from "../src/export/themes.ts";
import { jobReport, tailorVariant } from "../src/job.ts";
import { coverage, mentions, suggestSkills } from "../src/keywords.ts";
import { lint } from "../src/lint.ts";
import { Resume } from "../src/schema.ts";
import { sectionByKey } from "../src/sections.ts";
import { isDuplicate, saveSource } from "../src/sources.ts";
import { load } from "../src/store.ts";
import { applyVariant, tighten, viewToResume } from "../src/variants.ts";

const example = () => load("examples/resume.example.json");

const career = () =>
  Resume.parse({
    basics: { name: "Test Person", email: "t@example.com", summary: "Engineer." },
    work: [
      { name: "Now Co", position: "Lead", startDate: "2023-01", highlights: ["Led Laravel team", "Cut costs 20%", "Ran hiring"], tags: ["leadership"] },
      { name: "Api Co", position: "Engineer", startDate: "2020-01", endDate: "2022-12", summary: "APIs.", highlights: ["Built REST API platform"], tags: ["api"] },
      { name: "Old Co", position: "Junior", startDate: "2012-01", endDate: "2015-12", highlights: ["Fixed bugs"] },
    ],
    publications: [
      { name: "Laravel talk", releaseDate: "2024-01" },
      { name: "Gardening blog", releaseDate: "2024-06" },
    ],
  });

describe("keywords", () => {
  test("short terms are case-sensitive, aliases match", () => {
    expect(mentions("Built in Go", "Go")).toBe(true);
    expect(mentions("go to market", "Go")).toBe(false);
    expect(mentions("Postgres backed", "PostgreSQL")).toBe(true);
    expect(mentions("the rest of it", "REST API")).toBe(false);
  });

  test("coverage splits covered and missing", () => {
    const cov = coverage(career(), ["Laravel", "Kubernetes", "laravel"]);
    expect(cov.covered).toEqual(["Laravel"]);
    expect(cov.missing).toEqual(["Kubernetes"]);
  });

  test("suggestSkills finds unlisted terms", () => {
    const skills = suggestSkills(career());
    expect(skills.flatMap((s) => s.keywords)).toContain("Laravel");
  });
});

describe("variants", () => {
  test("tags filter keeps untagged entries", () => {
    const view = applyVariant(career(), { tags: ["api"] });
    expect(view.work.map((w) => w.name)).toEqual(["Api Co", "Old Co"]);
  });

  test("excludeTags drops entries", () => {
    expect(applyVariant(career(), { excludeTags: ["leadership"] }).work.map((w) => w.name)).toEqual(["Api Co", "Old Co"]);
  });

  test("earlierCareerBefore and maxRoles move roles to earlier career", () => {
    const view = applyVariant(career(), { earlierCareerBefore: "2016" });
    expect(view.work.map((w) => w.name)).toEqual(["Now Co", "Api Co"]);
    expect(view.earlierCareer?.map((w) => w.name)).toEqual(["Old Co"]);

    const capped = applyVariant(career(), { maxRoles: 1 });
    expect(capped.work.map((w) => w.name)).toEqual(["Now Co"]);
    expect(capped.earlierCareer?.map((w) => w.name)).toEqual(["Api Co", "Old Co"]);
  });

  test("keywords pick relevant roles and rank highlights", () => {
    const view = applyVariant(career(), { keywords: ["REST API"], maxRoles: 1, maxHighlights: 1 });
    expect(view.work.map((w) => w.name)).toEqual(["Api Co"]);
    const ranked = applyVariant(career(), { keywords: ["hiring"], maxHighlights: 1 });
    expect(ranked.work[0]!.highlights).toEqual(["Ran hiring"]);
    expect(applyVariant(career(), { keywords: ["Laravel"], maxPublications: 1 }).publications.map((p) => p.name)).toEqual(["Laravel talk"]);
  });

  test("overrides, dropRoleSummaries and block order", () => {
    const view = applyVariant(career(), { basics: { label: "API Person" }, dropRoleSummaries: true, blocks: ["experience", "summary"] });
    expect(view.basics.label).toBe("API Person");
    expect(view.work[1]!.summary).toBeUndefined();
    const text = renderText(view);
    expect(text.indexOf("EXPERIENCE")).toBeLessThan(text.indexOf("SUMMARY"));
    expect(text).not.toContain("PUBLICATIONS");
    expect(renderHtml(view)).not.toContain("s-publications");
  });

  test("does not mutate the source resume", () => {
    const r = career();
    applyVariant(r, { maxRoles: 1, maxHighlights: 1, dropRoleSummaries: true });
    expect(r.work).toHaveLength(3);
    expect(r.work[0]!.highlights).toHaveLength(3);
  });

  test("viewToResume folds earlier roles back in, without detail", () => {
    const r = viewToResume(applyVariant(career(), { maxRoles: 1 }));
    expect(r.work.map((w) => w.name)).toEqual(["Now Co", "Api Co", "Old Co"]);
    expect(r.work[1]!.highlights).toBeUndefined();
    expect("earlierCareer" in r).toBe(false);
  });

  test("tighten only yields steps that change something", () => {
    const steps = [...tighten({ dropRoleSummaries: true }, career())].map((s) => s.step);
    expect(steps).not.toContain("hide role summaries");
    expect(steps[0]).toBe("max 2 highlights per role");
  });

  test("tailorVariant merges job keywords onto a base", () => {
    const v = tailorVariant({ title: "DevRel", company: "Acme", keywords: ["Laravel"] }, "https://x.test/job", { keywords: ["PHP"], theme: "compact" });
    expect(v.keywords).toEqual(["PHP", "Laravel"]);
    expect(v.theme).toBe("compact");
    expect(v.job?.company).toBe("Acme");
    expect(jobReport({ title: "DevRel" }, coverage(career(), ["Laravel"]), "https://x.test")).toContain("Keyword coverage: 100%");
  });
});

describe("lint", () => {
  test("flags empty skills, weak openers and duplicates", () => {
    const r = career();
    r.work[0]!.highlights!.push("Responsible for deployments", "Built REST API platform");
    const messages = lint(r).map((i) => i.message).join("\n");
    expect(messages).toContain("Skills is empty");
    expect(messages).toContain("starts weakly");
    expect(messages).toContain("duplicate highlight");
  });

  test("schema errors short-circuit", () => {
    const issues = lint({ ...career(), work: [{ name: 1 }] } as never);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe("error");
  });
});

describe("sources", () => {
  test("duplicates match on title, name or url", () => {
    const s = sectionByKey("publications");
    const existing = [{ name: "Talk A", url: "https://a.test" }];
    expect(isDuplicate(s, existing, { name: "talk a", publisher: "Conf" })).toBe(true);
    expect(isDuplicate(s, existing, { name: "Other", url: "https://a.test" })).toBe(true);
    expect(isDuplicate(s, existing, { name: "New talk" })).toBe(false);
  });

  test("saveSource replaces the same url+target", () => {
    const r = career();
    saveSource(r, { url: "https://a.test", target: "publications" });
    saveSource(r, { url: "https://a.test", target: "publications", effort: "max" });
    expect(r.meta?.sources).toEqual([{ url: "https://a.test", target: "publications", effort: "max" }]);
  });
});

describe("ATS check (renders real PDFs)", () => {
  const renderer = new PdfRenderer();
  afterAll(() => renderer.close());

  test.each(THEMES.map((t) => [t.id, t] as const))("%s theme passes", async (_, theme) => {
    const view = applyVariant(await example());
    const report = await checkAts(await renderer.render(view, theme, "A4"), view);
    expect(report).toMatchObject({ ok: true, missing: [], outOfOrder: [] });
    expect(report.pages).toBe(1);
  }, 30_000);

  test("wide letter-spaced serif headings fail", async () => {
    const view = applyVariant(await example());
    const bad: Theme = { ...THEMES[0]!, id: "bad", css: `h2 { font: 13pt Charter, Georgia, serif; text-transform: uppercase; letter-spacing: 0.2em; }` };
    const report = await checkAts(await renderer.render(view, bad, "A4"), view);
    expect(report.ok).toBe(false);
    expect(report.missing.some((m) => m.startsWith("heading"))).toBe(true);
  }, 30_000);
});
