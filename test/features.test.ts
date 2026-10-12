import { afterAll, describe, expect, test } from "bun:test";
import { checkAts } from "../src/export/ats.ts";
import { renderHtml } from "../src/export/html.ts";
import { connectIchabod, exportResume, ichabodEndpoint, PdfRenderer } from "../src/export/index.ts";
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

  test("when trimming without keywords, quantified highlights are kept first", () => {
    const r = career();
    r.work[0]!.highlights = ["Ran hiring", "Led Laravel team", "Cut costs 20%"];
    expect(applyVariant(r, { maxHighlights: 1 }).work[0]!.highlights).toEqual(["Cut costs 20%"]);
    expect(applyVariant(r, {}).work[0]!.highlights).toEqual(["Cut costs 20%", "Ran hiring", "Led Laravel team"]);
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

  test("tighten trims peripheral sections and skill lists before experience", () => {
    const r = career();
    r.interests = [{ name: "Climbing" }];
    r.volunteer = [{ organization: "Code Club" }];
    r.skills = [{ name: "Backend", keywords: Array.from({ length: 12 }, (_, i) => `Skill ${i}`) }];
    const steps = [...tighten({}, r)];
    const names = steps.map((s) => s.step);
    expect(names.indexOf("drop Interests")).toBeLessThan(names.indexOf("max 2 highlights per role"));
    expect(names.indexOf("max 8 skills per group")).toBeLessThan(names.indexOf("max 2 highlights per role"));
    const after = steps.find((s) => s.step === "max 8 skills per group")!.variant;
    expect(after.blocks).not.toContain("interests");
    expect(applyVariant(r, after).skills[0]!.keywords).toHaveLength(8);
    expect(names).not.toContain("drop Awards & Certificates"); // nothing to drop
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

  test("a section the variant hides isn't expected in the PDF", async () => {
    const r = await example();
    r.volunteer = [{ organization: "Code Club", position: "Mentor" }];
    const view = applyVariant(r, { blocks: ["summary", "experience", "skills"] });
    const report = await checkAts(await renderer.render(view, THEMES[0]!, "A4"), view);
    expect(report.missing.filter((m) => m.startsWith("heading"))).toEqual([]);
  }, 30_000);

  test("wide letter-spaced serif headings fail", async () => {
    const view = applyVariant(await example());
    const bad: Theme = { ...THEMES[0]!, id: "bad", css: `h2 { font: 13pt Charter, Georgia, serif; text-transform: uppercase; letter-spacing: 0.2em; }` };
    const report = await checkAts(await renderer.render(view, bad, "A4"), view);
    expect(report.ok).toBe(false);
    expect(report.missing.some((m) => m.startsWith("heading"))).toBe(true);
  }, 30_000);
});

describe("Ichabod PDF browser", () => {
  const withEnv = async <T>(env: Record<string, string | undefined>, fn: () => Promise<T>) => {
    const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };

  /** Run with the ICHABOD_* overrides unset, so defaults apply. */
  const withoutEngine = <T>(fn: () => T): T => {
    const keys = ["ICHABOD_HOST", "ICHABOD_ENGINE", "ICHABOD_VERSION"];
    const old = keys.map((k) => process.env[k]);
    keys.forEach((k) => delete process.env[k]);
    try {
      return fn();
    } finally {
      keys.forEach((k, i) => (old[i] === undefined ? delete process.env[k] : (process.env[k] = old[i])));
    }
  };

  test("builds the wss://<host>/{engine}/{version} endpoint, Gecko by default", () => {
    expect(withoutEngine(() => ichabodEndpoint())).toBe("wss://stage.api.ichabod.nonprod.webservices.mozgcp.net/gecko/157");
    expect(ichabodEndpoint("api.example.test", "chromium")).toBe("wss://api.example.test/chromium/154");
    expect(ichabodEndpoint("https://api.example.test/", "chromium", "154")).toBe("wss://api.example.test/chromium/154");
    expect(ichabodEndpoint("ws://127.0.0.1:9000", "chromium", "200")).toBe("ws://127.0.0.1:9000/chromium/200");
  });

  test("sends the key as Basic auth for user api", async () => {
    // A stand-in that records the WebSocket upgrade and refuses it.
    let seen: { path: string; auth: string | null } | undefined;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen = { path: new URL(req.url).pathname, auth: req.headers.get("authorization") };
        return new Response("no", { status: 401 });
      },
    });
    try {
      const env = { ICHABOD_HOST: `ws://127.0.0.1:${server.port}`, ICHABOD_ENGINE: undefined, ICHABOD_VERSION: undefined };
      const err = await withEnv(env, () => connectIchabod({ key: "secret-key", attempts: 1 }).catch((e: Error) => e));
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Couldn't connect to Ichabod");
      expect((err as Error).message).not.toContain("secret-key");
      expect(seen).toEqual({ path: "/gecko/157", auth: `Basic ${btoa("api:secret-key")}` });
    } finally {
      server.stop(true);
    }
  });

  test("a slow Ichabod gets one retry; a late session is closed, not left running", async () => {
    const statuses: string[] = [];
    const closed: string[] = [];
    const fakeBrowser = (name: string) => ({ close: async () => void closed.push(name) }) as never;
    let calls = 0;
    const browser = await connectIchabod({
      key: "k",
      attemptMs: 30,
      status: (m) => statuses.push(m),
      connect: () => {
        calls++;
        // First attempt answers only after we've given up; the second answers at once.
        return calls === 1 ? Bun.sleep(80).then(() => fakeBrowser("late")) : Promise.resolve(fakeBrowser("second"));
      },
    });
    expect(calls).toBe(2);
    expect(statuses).toEqual(["Waiting for an Ichabod browser", "Ichabod is busy; trying again (2/2)"]);
    await Bun.sleep(100);
    expect(closed).toEqual(["late"]);
    await (browser as { close(): Promise<void> }).close();
    expect(closed).toEqual(["late", "second"]);
  });

  test("Ichabod: a refused connection isn't retried; a busy one fails with a clear message", async () => {
    let calls = 0;
    const refused = await connectIchabod({ key: "k", connect: async () => (calls++, Promise.reject(new Error("401 Unauthorized"))) }).catch((e: Error) => e);
    expect(calls).toBe(1);
    expect((refused as Error).message).toContain("401 Unauthorized");
    const busy = await connectIchabod({ key: "k", attemptMs: 10, connect: () => new Promise(() => {}) }).catch((e: Error) => e);
    expect((busy as Error).message).toContain("didn't provide a browser within 0.01s (2 tries)");
    expect((busy as Error).message).toContain("switch PDF browser to local");
  });

  test("exports use Ichabod when chosen, and say so when the key is missing", async () => {
    const err = await withEnv({ RESUME_PDF_BROWSER: "ichabod", ICHABOD_API_KEY: undefined }, async () => {
      expect(new PdfRenderer().where).toBe("ichabod");
      // The page preview pins local whatever the setting.
      expect(new PdfRenderer({ browser: "local" }).where).toBe("local");
      return exportResume({ resume: await example(), formats: ["pdf"] }).catch((e: Error) => e);
    });
    expect((err as Error).message).toContain("no Ichabod key is set");
  });

  test("one session per run: reused across PDFs, closed at the end, retried after a failed open", async () => {
    let opened = 0;
    let closed = 0;
    let fail = true;
    const page = { setContent: async () => {}, pdf: async () => new Uint8Array([37, 80, 68, 70]), close: async () => {} };
    const browser = { newPage: async () => page, close: async () => void closed++ };
    const renderer = new PdfRenderer({
      open: async () => {
        opened++;
        if (fail) throw new Error("busy");
        return browser as never;
      },
    });
    const view = applyVariant(await example());
    await expect(renderer.render(view, THEMES[0]!, "A4")).rejects.toThrow("busy");
    fail = false;
    await renderer.render(view, THEMES[0]!, "A4");
    await renderer.render(view, THEMES[1]!, "A4");
    expect(opened).toBe(2);
    await renderer.close();
    await renderer.close();
    expect(closed).toBe(1);
  });
});
