import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { load } from "../src/store.ts";
import { App } from "../src/tui/app.tsx";
import { StoreProvider } from "../src/tui/store.tsx";
import { fakeAI, LEGACY } from "./fixtures.ts";
import type { AI } from "../src/ai/index.ts";
import { ensureApplication, loadApplication } from "../src/applications.ts";
import { loadConfig, saveConfig } from "../src/config.ts";

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** Poll until a condition holds (or time out), instead of guessing how long the UI needs under load. */
async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await tick(30);
  }
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function setup(opts: { firstRun?: boolean; resume?: object; ai?: AI } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rm-tui-"));
  const path = join(dir, "resume.json");
  await Bun.write(path, opts.resume ? JSON.stringify(opts.resume) : await Bun.file("examples/resume.example.json").text());
  let quit = false;
  const t = await testRender(
    <StoreProvider initial={await load(path)} path={path} ai={opts.ai}>
      <App onQuit={() => (quit = true)} firstRun={opts.firstRun} />
    </StoreProvider>,
    { width: 120, height: 32 },
  );
  cleanup.push(async () => {
    t.renderer.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  const press = async (...keys: string[]) => {
    for (const k of keys) {
      if (["up", "down", "left", "right"].includes(k)) t.mockInput.pressArrow(k as "up");
      else if (k === "enter") t.mockInput.pressEnter();
      else if (k === "esc") t.mockInput.pressEscape();
      else if (k === "tab") t.mockInput.pressTab();
      else if (k === "space") t.mockInput.pressKey(" ");
      else if (k.startsWith("shift+")) {
        const rest = k.slice(6);
        if (["up", "down", "left", "right"].includes(rest)) t.mockInput.pressArrow(rest as "up", { shift: true });
        else t.mockInput.pressKey(rest.toUpperCase(), { shift: true });
      }
      else if (k.startsWith("ctrl+")) t.mockInput.pressKey(k.slice(5), { ctrl: true });
      else t.mockInput.pressKey(k);
      await tick(k === "esc" ? 100 : 40);
    }
    await t.renderOnce();
  };
  const type = async (s: string) => {
    await t.mockInput.typeText(s);
    await tick();
    await t.renderOnce();
  };
  const frame = () => t.captureCharFrame();
  // Saves are async (and slower when other suites are busy rendering PDFs): wait until the file settles.
  const saved = async () => {
    await tick(60);
    let last = await Bun.file(path).text();
    for (let i = 0; i < 40; i++) {
      await tick(50);
      const now = await Bun.file(path).text();
      if (now === last) break;
      last = now;
    }
    return load(path);
  };
  // Open a view through the command palette, the way a user would without memorising the nav.
  const open = async (label: string) => {
    await press(":");
    await until(async () => (await t.renderOnce(), frame().includes("Go to or do anything")));
    await type(`go to ${label}`);
    await press("enter");
    await until(async () => (await t.renderOnce(), !frame().includes("Go to or do anything")));
  };
  await tick();
  await t.renderOnce();
  return { press, type, frame, saved, quit: () => quit, open };
}

describe("TUI", () => {
  test("renders navigation and basics", async () => {
    const ui = await setup();
    const f = ui.frame();
    expect(f).toContain("resume-manager");
    expect(f).toContain("Work              2");
    expect(f).toContain("Ada Example");
    expect(f).toContain("✔ saved");
  });

  test("edits a basics field and saves it", async () => {
    const ui = await setup();
    await ui.press("enter", "down", "enter"); // main pane → Label → edit
    await ui.type(" & Mentor");
    await ui.press("enter");
    expect((await ui.saved()).basics.label).toBe("Senior Backend Engineer & Mentor");
  });

  test("esc cancels an edit", async () => {
    const ui = await setup();
    await ui.press("enter", "enter");
    await ui.type("ZZZ");
    await ui.press("esc");
    expect(ui.frame()).not.toContain("ZZZ");
    expect((await ui.saved()).basics.name).toBe("Ada Example");
  });

  test("adds a work entry, starting on the required field", async () => {
    const ui = await setup();
    await ui.open("Work");
    await ui.press("a"); // nav: Work → list → add
    expect(ui.frame()).toContain("not saved: Work #3 needs Name");
    await ui.type("Brand New Co");
    await ui.press("enter");
    const r = await ui.saved();
    expect(r.work).toHaveLength(3);
    expect(r.work[2]!.name).toBe("Brand New Co");
    expect(ui.frame()).toContain("✔ saved");
  });

  test("adds, reorders and deletes highlights", async () => {
    const ui = await setup();
    await ui.open("Work");
    await ui.press("enter"); // Work → first entry → form
    for (let i = 0; i < 7; i++) await ui.press("down"); // Highlights
    await ui.press("enter", "a");
    await ui.type("Mentored four engineers");
    await ui.press("enter");
    expect((await ui.saved()).work[0]!.highlights).toEqual([
      "Designed v2 REST API used by 3k integrators",
      "Cut p95 latency by 40%",
      "Mentored four engineers",
    ]);
    await ui.press("shift+up");
    expect((await ui.saved()).work[0]!.highlights![1]).toBe("Mentored four engineers");
    await ui.press("up", "d");
    expect((await ui.saved()).work[0]!.highlights).toEqual(["Mentored four engineers", "Cut p95 latency by 40%"]);
  });

  test("deleting an entry asks first", async () => {
    const ui = await setup();
    await ui.open("Work");
    await ui.press("d");
    expect(ui.frame()).toContain('Delete "Acme Corp');
    await ui.press("n");
    expect((await ui.saved()).work).toHaveLength(2);
    await ui.press("d", "y");
    expect((await ui.saved()).work.map((w) => w.name)).toEqual(["Widgets Ltd"]);
  });

  test("reorders and sorts entries", async () => {
    const ui = await setup();
    await ui.open("Work");
    await ui.press("shift+down");
    expect((await ui.saved()).work.map((w) => w.name)).toEqual(["Widgets Ltd", "Acme Corp"]);
    expect(ui.frame()).toContain("sort ▲");
    await ui.press("s");
    expect((await ui.saved()).work.map((w) => w.name)).toEqual(["Acme Corp", "Widgets Ltd"]);
  });

  test("validates dates before saving", async () => {
    const ui = await setup();
    await ui.open("Work");
    await ui.press("enter", "down", "down", "down", "down", "enter"); // Start Date
    await ui.press("ctrl+u");
    await ui.type("March 2022");
    await ui.press("enter");
    expect(ui.frame()).toContain("Use YYYY, YYYY-MM or YYYY-MM-DD");
    await ui.press("esc");
    expect((await ui.saved()).work[0]!.startDate).toBe("2022-04");
  });

  test("tags field takes comma-separated values", async () => {
    const ui = await setup();
    await ui.open("Work");
    await ui.press("enter");
    for (let i = 0; i < 8; i++) await ui.press("down"); // Tags
    await ui.press("enter");
    await ui.type("API, leadership");
    await ui.press("enter");
    expect((await ui.saved()).work[0]!.tags).toEqual(["API", "leadership"]);
  });

  test("q is typed into fields, not treated as quit", async () => {
    const ui = await setup();
    await ui.press("enter", "enter");
    await ui.type("q");
    expect(ui.quit()).toBe(false);
    await ui.press("esc", "esc", "q");
    expect(ui.quit()).toBe(true);
  });

  test("help overlay opens and closes", async () => {
    const ui = await setup();
    await ui.press("?");
    expect(ui.frame()).toContain("reorder entries or list items");
    await ui.press("x");
    expect(ui.frame()).not.toContain("reorder entries or list items");
  });

  test("issues view jumps to the problem", async () => {
    const ui = await setup();
    // Remove highlights from Acme to create a content issue, via the CLI-equivalent edit.
    await ui.open("Work");
    await ui.press("enter");
    for (let i = 0; i < 7; i++) await ui.press("down");
    await ui.press("x", "esc", "esc");
    await ui.open("Issues");
    expect(ui.frame()).toContain('work[0] "Acme Corp" has no highlights');
    await ui.press("enter");
    expect(ui.frame()).toContain("Work (2)");
  });

  test("imports a JSON Resume file, leaving possible duplicates unticked", async () => {
    const ui = await setup();
    const file = join(await mkdtemp(join(tmpdir(), "rm-legacy-")), "old.json");
    await Bun.write(file, JSON.stringify(LEGACY));
    await ui.open("Import");
    await ui.press("enter", "down", "enter"); // Source → JSON Resume
    expect(ui.frame()).toContain("Import · JSON Resume");
    await ui.press("down", "enter");
    await ui.type(file);
    await ui.press("enter", "r");
    await new Promise((r) => setTimeout(r, 150));
    await ui.press("down"); // let the modal render
    const modal = ui.frame();
    expect(modal).toContain("Import 4 new entries");
    expect(modal).toContain("[ ] Work: Acme Corp — Lead Engineer");
    expect(modal).toContain("similar to Acme Corp");
    expect(modal).toContain("[x] Talks & articles: Talk");
    await ui.press("enter");
    const r = await ui.saved();
    expect(r.work).toHaveLength(2);
    expect(r.publications.map((p) => p.name)).toContain("Talk");
    expect(r.education.map((e) => e.institution)).toContain("Uni of Example");
    expect(r.basics.name).toBe("Ada Example"); // yours kept
    expect(r.basics.image).toBe("https://grace.example/me.png"); // empty field filled
    expect(ui.frame()).toContain("Not imported (unknown fields)");
  });

  test("preview shows the plain-text resume", async () => {
    const ui = await setup();
    await ui.open("Preview");
    const f = ui.frame();
    expect(f).toContain("EXPERIENCE");
    expect(f).toContain("Senior Backend Engineer | Acme Corp");
  });

  test("undo and redo edits, deletes and imports", async () => {
    const ui = await setup();
    await ui.press("enter", "enter");
    await ui.press("ctrl+u");
    await ui.type("Grace");
    await ui.press("enter", "esc"); // save, back to nav
    expect((await ui.saved()).basics.name).toBe("Grace");
    await ui.press("u");
    expect(ui.frame()).toContain("Undid: edit Name");
    expect((await ui.saved()).basics.name).toBe("Ada Example");
    await ui.press("shift+u");
    expect((await ui.saved()).basics.name).toBe("Grace");

    await ui.open("Work");
    await ui.press("d", "y");
    expect((await ui.saved()).work).toHaveLength(1);
    await ui.press("u");
    expect(ui.frame()).toContain("Undid: delete Acme Corp");
    expect((await ui.saved()).work.map((w) => w.name)).toEqual(["Acme Corp", "Widgets Ltd"]);
  });

  test("u inside a text field types u, it doesn't undo", async () => {
    const ui = await setup();
    await ui.press("enter", "enter");
    await ui.type("u");
    await ui.press("enter");
    expect((await ui.saved()).basics.name).toBe("Ada Exampleu");
  });

  test("palette finds actions by words and runs them", async () => {
    const ui = await setup();
    await ui.press(":");
    expect(ui.frame()).toContain("Go to or do anything");
    await ui.type("add work");
    await until(() => ui.frame().includes("Add Work entry"));
    expect(ui.frame()).toContain("Add Work entry");
    await ui.press("enter");
    await until(() => ui.frame().includes("not saved: Work #3"));
    expect(ui.frame()).toContain("not saved: Work #3 needs Name");
    await ui.type("Palette Co");
    await ui.press("enter");
    expect((await ui.saved()).work.map((w) => w.name)).toContain("Palette Co");
  });

  test("an intent doesn't re-fire when the view is reopened by hand", async () => {
    const ui = await setup();
    await ui.open("Work"); // via palette: plain go-to, no intent
    await ui.press(":");
    await ui.type("add work");
    await ui.press("enter");
    await ui.type("Once Co");
    await ui.press("enter", "esc", "esc", "up", "down"); // leave Work and come back
    await ui.press("enter");
    expect((await ui.saved()).work).toHaveLength(3);
  });

  test("palette: escape closes, no match says so", async () => {
    const ui = await setup();
    await ui.press(":");
    await ui.type("zzzzqq");
    expect(ui.frame()).toContain('No action matches "zzzzqq"');
    await ui.press("esc");
    expect(ui.frame()).not.toContain("Go to or do anything");
  });

  test("empty sections are tucked away until asked for", async () => {
    const ui = await setup();
    let f = ui.frame();
    expect(f).not.toContain("Awards");
    expect(f).toMatch(/\+ \d more sections/);
    await ui.open("Awards"); // palette can still reach hidden sections
    expect(ui.frame()).toContain("Awards (0)");
    await ui.press(":");
    await ui.type("show all sections");
    await ui.press("enter");
    f = ui.frame();
    expect(f).toContain("Certificates");
    expect(f).toContain("− fewer sections");
  });

  test("first run shows the welcome screen", async () => {
    const ui = await setup({ firstRun: true, resume: {} });
    const f = ui.frame();
    expect(f).toContain("Let's get your resume in.");
    expect(f).toContain("Import an existing JSON Resume");
    await ui.press("1");
    expect(ui.frame()).toContain("Import · JSON Resume");
  });

  test("welcome: sample data loads and can be undone", async () => {
    const ui = await setup({ firstRun: true, resume: {} });
    await ui.press("4");
    expect((await ui.saved()).basics.name).toBe("Ada Example");
    await ui.press("esc", "u");
    expect((await ui.saved()).basics.name).toBeUndefined();
  });

  test("welcome: start from GitHub or GitLab asks where, then the username", async () => {
    const ui = await setup({ firstRun: true, resume: {} });
    await ui.press("2");
    expect(ui.frame()).toContain("Where's your code?");
    expect(ui.frame()).toContain("Self-hosted GitLab");
    await ui.press("down", "enter"); // GitLab (gitlab.com)
    await until(() => ui.frame().includes("Your GitLab username"));
    expect(ui.frame()).toContain("Your GitLab username");
    await ui.press("esc");
    expect(ui.frame()).toContain("Let's get your resume in.");
  });

  test("welcome: fill in my details starts editing the name", async () => {
    const ui = await setup({ firstRun: true, resume: {} });
    await ui.press("3");
    await ui.type("New Person");
    await ui.press("enter");
    expect((await ui.saved()).basics.name).toBe("New Person");
  });

  test("w rewrites the summary with the writing coach", async () => {
    const ai = fakeAI({ options: [{ style: "shorter", text: "Backend engineer for APIs and reliable systems." }, { style: "result", text: "Builds reliable APIs developers enjoy." }] });
    const ui = await setup({ ai });
    await ui.press("enter");
    for (let i = 0; i < 6; i++) await ui.press("down"); // Summary
    await ui.press("w");
    await new Promise((r) => setTimeout(r, 80));
    await ui.press("down", "up");
    expect(ui.frame()).toContain("Keep original");
    expect(ui.frame()).toContain("Builds reliable APIs developers enjoy.");
    await ui.press("2");
    expect((await ui.saved()).basics.summary).toBe("Builds reliable APIs developers enjoy.");
    await ui.press("u");
    expect((await ui.saved()).basics.summary).toContain("Backend engineer focused on API design");
  });

  test("coach interviews a role and adds the bullets you pick", async () => {
    const ai = fakeAI(
      { questions: [{ question: "How many integrators?", why: "scale" }, { question: "Anything else?", why: "more" }] },
      { bullets: ["Grew API adoption to 3k integrators in 18 months", "Saved 99 years of time"] },
    );
    const ui = await setup({ ai });
    await ui.open("Coach");
    expect(ui.frame()).toContain("Coach");
    await ui.press("enter");
    await new Promise((r) => setTimeout(r, 60));
    await ui.press("down", "up");
    expect(ui.frame()).toContain("How many integrators?");
    await ui.type("3k integrators within 18 months");
    await ui.press("ctrl+s");
    await ui.press("ctrl+s"); // skip the second question
    await new Promise((r) => setTimeout(r, 80));
    await ui.press("down", "up");
    const f = ui.frame();
    expect(f).toContain("Grew API adoption to 3k integrators in 18 months");
    expect(f).toContain("1 dropped"); // "99 years" isn't in the answers
    await ui.press("enter");
    const r = await ui.saved();
    expect(r.work.flatMap((w) => w.highlights ?? [])).toContain("Grew API adoption to 3k integrators in 18 months");
  });

  test("evidence view lists unsupported skills and can add unlisted ones", async () => {
    const ui = await setup();
    await ui.open("Evidence");
    let f = ui.frame();
    expect(f).toContain("Evidence · problems");
    await ui.press("f");
    await until(() => ui.frame().includes("Evidence · all"));
    await ui.press("f");
    await until(() => ui.frame().includes("Evidence · unlisted"));
    f = ui.frame();
    expect(f).toContain("Evidence · unlisted");
  });

  test("applications: change status from the list", async () => {
    await ensureApplication({ slug: "acme-dev", company: "Acme", title: "Developer", variant: "devrel" });
    const ui = await setup();
    await ui.open("Applications");
    expect(ui.frame()).toContain("Acme — Developer");
    await ui.press("s");
    await until(() => ui.frame().includes("Status for Acme"));
    await ui.press("down", "enter"); // draft → applied
    await until(async () => (await loadApplication("acme-dev"))?.status === "applied");
    const app = await loadApplication("acme-dev");
    expect(app?.status).toBe("applied");
    expect(app?.followUp).toBeDefined();
  });

  test("inbox view shows an empty state with how to schedule it", async () => {
    const ui = await setup();
    await ui.open("Inbox");
    expect(ui.frame()).toContain("cv inbox");
  });

  test("nav groups the new tools", async () => {
    const f = (await setup()).frame();
    for (const label of ["IMPROVE", "GROW", "APPLY", "Coach", "Evidence", "Inbox", "Applications"]) expect(f).toContain(label);
  });

  test("settings: set a monthly budget, saved to the user config", async () => {
    await saveConfig({});
    const ui = await setup();
    await ui.open("Settings");
    await new Promise((r) => setTimeout(r, 300)); // doctor checks
    await ui.press("down"); // Monthly budget
    expect(ui.frame()).toContain("Monthly budget   none");
    await ui.press("enter");
    await ui.type("12.5");
    await ui.press("enter");
    await new Promise((r) => setTimeout(r, 100));
    expect((await loadConfig()).budget).toEqual({ monthlyUsd: 12.5 });
    await ui.press("up", "down");
    expect(ui.frame()).toContain("Monthly budget   $12.50");
    await saveConfig({});
  });
});
