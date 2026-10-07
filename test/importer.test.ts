import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMerge, parseText, planMerge, replaceResume, resolveSource, toResume } from "../src/importer.ts";
import { Resume } from "../src/schema.ts";
import { load } from "../src/store.ts";
import { LEGACY } from "./fixtures.ts";

describe("toResume", () => {
  const report = toResume("fixture", LEGACY);

  test("renames legacy fields", () => {
    expect(report.resume.basics).toMatchObject({ url: "https://grace.example", image: "https://grace.example/me.png", location: { city: "Bristol" } });
    expect(report.resume.work[0]).toMatchObject({ name: "Acme Corp", url: "https://acme.example" });
    expect(report.resume.education[0]!.score).toBe("3.8");
    expect(report.resume.publications[0]!.url).toBe("https://talk.example");
    expect(report.fixes).toEqual(expect.arrayContaining(["basics.website → url", "work[0].company → name", "education[0].gpa → score"]));
  });

  test("normalises loose dates, including numbers and 'Present'", () => {
    expect(report.resume.work[0]).toMatchObject({ startDate: "2022-03" });
    expect(report.resume.work[0]!.endDate).toBeUndefined();
    expect(report.resume.work[1]).toMatchObject({ startDate: "2018-09-01", endDate: "2022-02" });
    expect(report.resume.education[0]).toMatchObject({ startDate: "2010", endDate: "2014" });
    expect(report.resume.publications[0]!.releaseDate).toBe("2024-06");
  });

  test("reports unknown fields instead of silently dropping them", () => {
    expect(report.dropped).toEqual(expect.arrayContaining(["basics.x-pronouns", "work[0].pinned", "meta.theme", "customSection"]));
  });

  test("keeps valid entries when one is invalid", () => {
    expect(report.resume.work).toHaveLength(2);
    expect(report.invalid.map((i) => i.path)).toEqual(["work[2]"]);
  });

  test("rejects non-objects", () => {
    expect(() => toResume("x", [1, 2])).toThrow("expected an object");
  });
});

describe("parseText", () => {
  test("YAML keeps year-month dates as strings", () => {
    const yaml = "basics:\n  name: Ada\nwork:\n  - name: X\n    startDate: 2020-01\n    endDate: 2021-03-04\n";
    expect(parseText(yaml, "resume.yaml")).toEqual({ basics: { name: "Ada" }, work: [{ name: "X", startDate: "2020-01", endDate: "2021-03-04" }] });
  });

  test("detects YAML without an extension, JSON otherwise", () => {
    expect(parseText("basics:\n  name: Ada\n")).toEqual({ basics: { name: "Ada" } });
    expect(parseText('{"basics":{"name":"Ada"}}')).toEqual({ basics: { name: "Ada" } });
  });
});

describe("resolveSource", () => {
  test("registry usernames, registry URLs and gists", async () => {
    expect(await resolveSource("ada-example")).toEqual({ kind: "url", location: "https://registry.jsonresume.org/ada-example.json" });
    expect(await resolveSource("https://registry.jsonresume.org/ada")).toEqual({ kind: "url", location: "https://registry.jsonresume.org/ada.json" });
    expect(await resolveSource("https://gist.github.com/ada/abc123def")).toEqual({ kind: "url", location: "https://api.github.com/gists/abc123def" });
    expect(await resolveSource("examples/resume.example.json")).toEqual({ kind: "file", location: "examples/resume.example.json" });
    expect(resolveSource("./missing.json")).rejects.toThrow("No such file");
  });
});

describe("merge and replace", () => {
  test("planMerge adds new entries, skips duplicates, fills only empty basics", async () => {
    const current = await load("examples/resume.example.json");
    const incoming = toResume("x", LEGACY).resume;
    const plan = planMerge(current, incoming);
    // "Backend" skills already exist.
    expect(plan.duplicates.map((d) => d.label)).toEqual(["Backend — PHP, Go"]);
    // Both companies exist with different titles ("Lead Engineer" vs "Senior Backend Engineer", "Engineer" vs
    // "Software Engineer"), so they're offered as possible duplicates rather than silently skipped.
    expect(plan.add.map((a) => [a.section, !!a.similar])).toEqual([["work", true], ["work", true], ["publications", false], ["education", false]]);
    expect(plan.add[0]!.similar).toContain("Acme Corp — Senior Backend Engineer");
    expect(Object.keys(plan.fillBasics)).toEqual(["image"]);
    expect(plan.conflicts.map((c) => c.key)).toEqual(expect.arrayContaining(["name", "url", "location"]));

    applyMerge(current, plan);
    expect(current.basics.name).toBe("Ada Example");
    expect(current.education).toHaveLength(2);
    expect(current.work).toHaveLength(2); // possible duplicate skipped by default
    expect(planMerge(current, incoming).add.filter((a) => !a.similar)).toHaveLength(0); // idempotent
  });

  test("two roles at one company are not duplicates", () => {
    const current = Resume.parse({ work: [{ name: "Northwind Ltd", position: "CTO", startDate: "2019-08" }] });
    const incoming = Resume.parse({ work: [{ name: "Northwind Ltd", position: "Technical Director", startDate: "2024-10" }, { name: "Northwind Ltd", position: "CTO", startDate: "2019-08-01" }] });
    const plan = planMerge(current, incoming);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.add).toHaveLength(1);
    expect(plan.add[0]!.similar).toContain("CTO");
  });

  test("duplicates within one import are only added once", () => {
    const twice = Resume.parse({ skills: [{ name: "Go" }, { name: "Go" }] });
    expect(planMerge(Resume.parse({}), twice).add).toHaveLength(1);
  });

  test("replaceResume backs up and keeps tool settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rm-import-"));
    const path = join(dir, "resume.json");
    const current = Resume.parse({ basics: { name: "Old" }, meta: { pdf: { theme: "compact" }, sources: [{ url: "https://x.test", target: "publications" }] } });
    await Bun.write(path, JSON.stringify(current));
    const backup = await replaceResume(current, toResume("x", LEGACY).resume, path);
    expect(backup).toMatch(/resume\.backup-.*\.json$/);
    expect((await Bun.file(backup).json()).basics.name).toBe("Old");
    const replaced = await load(path);
    expect(replaced.basics.name).toBe("Grace Example");
    expect(replaced.meta?.pdf?.theme).toBe("compact");
    expect(replaced.meta?.sources).toHaveLength(1);
  });
});
