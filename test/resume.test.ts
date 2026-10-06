import { describe, expect, test } from "bun:test";
import { formatDate, formatRange, normaliseDate } from "../src/dates.ts";
import { renderHtml, safeColour } from "../src/export/html.ts";
import { THEMES, themeById } from "../src/export/themes.ts";
import { renderText } from "../src/export/text.ts";
import { Basics, Resume, Work } from "../src/schema.ts";
import { fieldsFor } from "../src/sections.ts";
import { isSortedRecent, sortRecent } from "../src/sort.ts";
import { load, prune } from "../src/store.ts";
import { toTabstackSchema } from "../src/tabstack.ts";

const example = () => load("examples/resume.example.json");

describe("dates", () => {
  test.each([
    ["2021", "2021"],
    ["2021-03", "2021-03"],
    ["2021-03-04T10:00:00Z", "2021-03-04"],
    ["March 2021", "2021-03"],
    ["Sept. 2019", "2019-09"],
    ["3/2020", "2020-03"],
    ["Present", undefined],
    ["", undefined],
  ])("normaliseDate(%p) -> %p", (input, expected) => {
    expect(normaliseDate(input)).toBe(expected as string | undefined);
  });

  test("format", () => {
    expect(formatDate("2021-03")).toBe("Mar 2021");
    expect(formatDate("2021")).toBe("2021");
    expect(formatRange("2020-01")).toBe("Jan 2020 – Present");
  });
});

test("prune drops empty values", () => {
  expect(prune<unknown>({ a: "", b: [], c: {}, d: " x ", e: [{ f: "" }], g: 0 })).toEqual({ d: "x", g: 0 });
});

test("fieldsFor derives kinds and skips nested objects", () => {
  const work = Object.fromEntries(fieldsFor(Work).map((f) => [f.key, f]));
  expect(work.name!.required).toBe(true);
  expect(work.startDate!.kind).toBe("date");
  expect(work.summary!.kind).toBe("multiline");
  expect(work.highlights!.kind).toBe("list");
  const basics = fieldsFor(Basics).map((f) => f.key);
  expect(basics).not.toContain("location");
  expect(basics).not.toContain("profiles");
});

test("tabstack schema is plain JSON Schema", () => {
  const json = JSON.stringify(toTabstackSchema(Work));
  expect(json).not.toContain("$schema");
  expect(json).not.toContain("additionalProperties");
  expect(json).not.toContain("pattern");
  expect(json).toContain("Company or organisation name");
});

test("example resume validates and loads defaults", async () => {
  const r = await example();
  expect(Resume.safeParse(r).success).toBe(true);
  expect(r.awards).toEqual([]);
});

test("renderers include key content and escape html", async () => {
  const r = await example();
  r.work[0]!.highlights!.push("<script>alert(1)</script>");
  const html = renderHtml(r);
  expect(html).toContain("Ada Example");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  const text = renderText(r);
  expect(text).toContain("EXPERIENCE");
  expect(text).toContain("Senior Backend Engineer | Acme Corp");
  expect(text).toContain("Apr 2022 – Present");
});

describe("sortRecent", () => {
  test("ongoing first, then latest end, then latest start, undated last", () => {
    const items = [
      { name: "undated" },
      { name: "old", startDate: "2015", endDate: "2017" },
      { name: "current-older-start", startDate: "2019-01" },
      { name: "recent", startDate: "2020-01", endDate: "2023-06" },
      { name: "current", startDate: "2023-07" },
      { name: "talk", releaseDate: "2024-02" },
    ];
    expect(isSortedRecent(items)).toBe(false);
    expect(sortRecent(items).map((i) => i.name)).toEqual([
      "current", "current-older-start", "talk", "recent", "old", "undated",
    ]);
    expect(isSortedRecent(items)).toBe(true);
  });

  test("example work is already sorted", async () => {
    expect(isSortedRecent((await example()).work)).toBe(true);
  });
});

describe("themes", () => {
  test.each(THEMES.map((t) => [t.id, t] as const))("%s renders", async (_, theme) => {
    const html = renderHtml(await example(), { theme });
    expect(html).toContain(`theme-${theme.id}`);
    expect(html).toContain("Acme Corp");
    expect(html.includes('class="layout"')).toBe(!!theme.sidebar);
  });

  test("sidebar moves contact out of the header", async () => {
    const html = renderHtml(await example(), { theme: themeById("sidebar") });
    expect(html).not.toContain('class="contacts"');
    expect(html).toMatch(/<aside class="side"><section class="s-contact">/);
  });

  test("accent must be a hex colour", async () => {
    expect(renderHtml(await example(), { accent: "#6d28d9" })).toContain("--accent: #6d28d9;");
    const html = renderHtml(await example(), { accent: "red; } body { display: none" });
    expect(html).not.toContain("display: none");
    expect(safeColour("#abc")).toBe("#abc");
    expect(safeColour("blue")).toBeUndefined();
  });
});
