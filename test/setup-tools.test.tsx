import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Tabstack from "@tabstack/sdk";
import { testRender } from "@opentui/react/test-utils";
import { applyEnvironment, CONFIG_FILE, loadConfig, maskKey, parseDotenv, resolveHome, saveConfig } from "../src/config.ts";
import { BudgetError, checkBudget, claudeCost, estimateClaude, formatUsd, monthSpend, record } from "../src/costs.ts";
import { runDoctor } from "../src/doctor.ts";
import { metered } from "../src/tabstack.ts";
import { closePreviewRenderer, pagePng, renderPreviewPdf } from "../src/tui/preview-render.ts";
import { THEMES } from "../src/export/themes.ts";
import { load } from "../src/store.ts";
import { applyVariant } from "../src/variants.ts";
import { App } from "../src/tui/app.tsx";
import { StoreProvider } from "../src/tui/store.tsx";

const tmp = (p: string) => mkdtemp(join(tmpdir(), p));

describe("config", () => {
  test("never writes the real config during tests", () => {
    expect(CONFIG_FILE.startsWith(tmpdir()) || CONFIG_FILE.includes("rm-test-config")).toBe(true);
  });

  test("saveConfig is owner-only and round-trips", async () => {
    await saveConfig({ home: "/x", keys: { tabstack: "ts_abcdefghijk" }, budget: { monthlyUsd: 5 } });
    expect((await stat(CONFIG_FILE)).mode & 0o777).toBe(0o600);
    expect(await loadConfig()).toMatchObject({ home: "/x", budget: { monthlyUsd: 5 } });
    await saveConfig({});
  });

  test("parseDotenv handles export, quotes and comments", () => {
    expect(parseDotenv("# c\nexport A=1\nB='two words'\nC=\"3\"\nnot a line")).toEqual({ A: "1", B: "two words", C: "3" });
  });

  test("resolveHome: RESUME_HOME > current folder with resume.json > config > cwd", async () => {
    const withResume = await tmp("rm-home-a-");
    await Bun.write(join(withResume, "resume.json"), "{}");
    const empty = await tmp("rm-home-b-");
    const saved = process.env.RESUME_HOME;
    delete process.env.RESUME_HOME;
    try {
      expect(await resolveHome(withResume, { home: "/configured" })).toEqual({ home: withResume, source: "current folder" });
      expect(await resolveHome(empty, { home: "/configured" })).toEqual({ home: "/configured", source: "config" });
      expect(await resolveHome(empty, {})).toEqual({ home: empty, source: "default" });
      process.env.RESUME_HOME = "/forced";
      expect((await resolveHome(withResume, {})).source).toBe("RESUME_HOME");
    } finally {
      if (saved === undefined) delete process.env.RESUME_HOME;
      else process.env.RESUME_HOME = saved;
    }
  });

  test("maskKey never shows the whole key", () => {
    expect(maskKey("sk-ant-1234567890abcdef")).toBe("sk-a…cdef");
    expect(maskKey(undefined)).toBe("not set");
  });
});

describe("costs", () => {
  test("prices Claude usage per model, estimates a call", () => {
    expect(claudeCost("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(6);
    expect(claudeCost("claude-sonnet-5-5", { input_tokens: 1_000_000 })).toBeCloseTo(2);
    expect(claudeCost("mystery-model", { input_tokens: 1 })).toBeUndefined();
    expect(estimateClaude(4000)).toBeGreaterThan(0.04);
    expect(estimateClaude(4000)).toBeLessThan(0.1);
    expect(formatUsd(0.034)).toBe("3¢");
    expect(formatUsd(2)).toBe("$2.00");
  });

  test("ledger totals the month and the budget refuses overspend", async () => {
    const before = (await monthSpend()).usd;
    await record({ service: "claude", op: "json", usd: 0.5 });
    await record({ service: "tabstack", op: "extract.json" });
    const s = await monthSpend();
    expect(s.usd).toBeCloseTo(before + 0.5);
    expect(s.unpriced).toBeGreaterThanOrEqual(1);
    await saveConfig({ budget: { monthlyUsd: s.usd + 1 } });
    await checkBudget(0.5, "small");
    await expect(checkBudget(2, "Tabstack research")).rejects.toBeInstanceOf(BudgetError);
    await saveConfig({});
  });

  test("metered Tabstack client records calls and checks the budget before research", async () => {
    let researched = false;
    const fake = {
      extract: { json: async () => ({ ok: true }), markdown: async () => ({ content: "" }) },
      generate: { json: async () => ({}) },
      agent: { research: async () => ((researched = true), []) },
      other: { thing: () => 1 },
    } as unknown as Tabstack;
    const m = metered(fake);
    const before = (await monthSpend()).tabstackCalls;
    expect(await m.extract.json({} as never)).toEqual({ ok: true });
    expect((await monthSpend()).tabstackCalls).toBe(before + 1);
    expect((m as unknown as { other: { thing: () => number } }).other.thing()).toBe(1);

    await saveConfig({ budget: { monthlyUsd: (await monthSpend()).usd + 0.5 } });
    await expect(m.agent.research({ query: "x" })).rejects.toBeInstanceOf(BudgetError);
    expect(researched).toBe(false);
    await saveConfig({});
  });
});

describe("applyEnvironment", () => {
  test("points paths at home, loads keys from config and the home .env, never overrides existing env", async () => {
    const home = await tmp("rm-env-home-");
    await Bun.write(join(home, "resume.json"), "{}");
    await Bun.write(join(home, ".env"), "RESUME_TEST_DOTENV=from-dotenv\n");
    await saveConfig({ keys: { github: "ghp_fromconfig123" } });
    const keep = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith("RESUME_") && !["RESUME_CONFIG_DIR"].includes(k)) delete process.env[k];
    delete process.env.GITHUB_TOKEN;
    process.env.RESUME_OUT_DIR = "/explicit/out";
    try {
      const env = await applyEnvironment(home);
      expect(env.source).toBe("current folder");
      expect(process.env.RESUME_PATH).toBe(join(home, "resume.json"));
      expect(process.env.RESUME_VARIANTS_DIR).toBe(join(home, "variants"));
      expect(process.env.RESUME_OUT_DIR).toBe("/explicit/out");
      expect(process.env.GITHUB_TOKEN as string | undefined).toBe("ghp_fromconfig123");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
      await saveConfig({});
    }
  });
});

describe("doctor", () => {
  test("offline checks, and flags personal files that aren't gitignored", async () => {
    const home = await tmp("rm-doctor-");
    await Bun.spawn(["git", "init", "-q", home]).exited;
    const saved = { home: process.env.RESUME_HOME, path: process.env.RESUME_PATH };
    process.env.RESUME_HOME = home;
    try {
      let checks = await runDoctor();
      const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
      expect(byId.git?.status).toBe("error");
      expect(byId.git?.detail).toContain("resume.json");
      expect(byId.chrome?.status).toBe("ok");
      expect(byId.config?.detail).toBe(CONFIG_FILE);

      await Bun.write(join(home, ".gitignore"), "/resume.json\n/applications/\n/variants/\n/reports/\n/.cache/\n.env\n");
      checks = await runDoctor();
      expect(checks.find((c) => c.id === "git")?.status).toBe("ok");
    } finally {
      process.env.RESUME_HOME = saved.home;
      process.env.RESUME_PATH = saved.path;
    }
  });
});

describe("preview rendering (Chrome + canvas)", () => {
  afterAll(() => closePreviewRenderer());

  test("renders a page to PNG and reuses unchanged renders", async () => {
    const view = applyVariant(await load("examples/resume.example.json"));
    const a = renderPreviewPdf(view, THEMES[0]!, "A4");
    expect(renderPreviewPdf(view, THEMES[0]!, "A4")).toBe(a); // cached by content
    const { pdf, pages } = await a;
    expect(pages).toBe(1);
    const png = await pagePng(pdf, 1, 600);
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  }, 30_000);

  test("Preview draws the page in the terminal", async () => {
    const saved = process.env.RESUME_PREVIEW;
    process.env.RESUME_PREVIEW = "page";
    const dir = await tmp("rm-preview-");
    const path = join(dir, "resume.json");
    await Bun.write(path, await Bun.file("examples/resume.example.json").text());
    const t = await testRender(
      <StoreProvider initial={await load(path)} path={path}>
        <App onQuit={() => {}} />
      </StoreProvider>,
      { width: 100, height: 40 },
    );
    try {
      const press = async (k: string, wait = 40) => {
        t.mockInput.pressKey(k);
        await new Promise((r) => setTimeout(r, wait));
        await t.renderOnce();
      };
      await press(":");
      await t.mockInput.typeText("go to preview");
      await new Promise((r) => setTimeout(r, 60));
      await t.renderOnce();
      t.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 60));
      await t.renderOnce();
      // Wait for Chrome + rasterising, without pressing keys (x would clear a field).
      for (let i = 0; i < 80 && !/[▀▄█▗▖▝▘]/.test(t.captureCharFrame()); i++) {
        await new Promise((r) => setTimeout(r, 100));
        await t.renderOnce();
      }
      const frame = t.captureCharFrame();
      expect(frame).toMatch(/[▀▄█▗▖▝▘]/); // blocks protocol in the test terminal
      expect(frame).toContain("page 1/1");
      await press("c", 60);
      expect(t.captureCharFrame()).toContain("Editorial");
      expect(t.captureCharFrame()).toContain("unsaved (s to keep)");
    } finally {
      t.renderer.destroy();
      process.env.RESUME_PREVIEW = saved;
    }
  }, 60_000);
});
