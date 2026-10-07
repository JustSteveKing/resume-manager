import Anthropic from "@anthropic-ai/sdk";
import { access, constants, mkdir } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { CONFIG_FILE, loadConfig, maskKey, resolveHome } from "./config.ts";
import { describeSpend, monthSpend } from "./costs.ts";
import { accountsFromResume } from "./forges/index.ts";
import { gitlabBase, gitlabToken } from "./forges/gitlab.ts";
import { githubToken } from "./github/collect.ts";
import { hasErrors, lint } from "./lint.ts";
import { load, RESUME_PATH } from "./store.ts";
import { tabstack } from "./tabstack.ts";

// `resume doctor` / Settings: is everything set up, and how do I fix what isn't?

export type CheckStatus = "ok" | "warn" | "error" | "info";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorOptions {
  /** Make live calls: free ones always (Claude token count, GitHub rate limit). */
  live?: boolean;
  /** Also test Tabstack, which has no free endpoint (uses one Extract call). */
  liveTabstack?: boolean;
  /** Terminal image support, when known (from the TUI renderer). */
  imageProtocol?: string;
}

const exists = (p: string) => access(p, constants.F_OK).then(() => true, () => false);
const which = async (cmd: string) => (await Bun.spawn(["which", cmd], { stdout: "ignore", stderr: "ignore" }).exited) === 0;

async function gitIgnored(home: string, paths: string[]): Promise<{ repo: boolean; exposed: string[] }> {
  const inRepo = (await Bun.spawn(["git", "-C", home, "rev-parse", "--is-inside-work-tree"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  if (!inRepo) return { repo: false, exposed: [] };
  const exposed: string[] = [];
  for (const p of paths) {
    const code = await Bun.spawn(["git", "-C", home, "check-ignore", "-q", p], { stdout: "ignore", stderr: "ignore" }).exited;
    if (code !== 0) exposed.push(p);
  }
  return { repo: true, exposed };
}

/** What the current terminal can show, guessed from the environment (the TUI knows for sure). */
export function guessImageSupport(): string {
  const t = `${process.env.TERM_PROGRAM ?? ""} ${process.env.TERM ?? ""}`.toLowerCase();
  if (t.includes("kitty") || t.includes("ghostty") || t.includes("wezterm")) return "kitty";
  if (t.includes("iterm")) return "sixel";
  return "blocks";
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const config = await loadConfig();
  // cli.ts records where the folder came from; fall back to resolving it ourselves.
  const resolved = await resolveHome(undefined, config);
  const home = process.env.RESUME_HOME ?? resolved.home;
  const source = (process.env.RESUME_HOME_SOURCE as typeof resolved.source | undefined) ?? resolved.source;

  // Data folder
  try {
    await mkdir(home, { recursive: true });
    await access(home, constants.W_OK);
    add({ id: "home", label: "Data folder", status: "ok", detail: `${home} (${source})`, fix: source === "default" ? "Run `resume init <folder>` so `resume` works from anywhere" : undefined });
  } catch {
    add({ id: "home", label: "Data folder", status: "error", detail: `${home} isn't writable`, fix: "Run `resume init <folder>` with a folder you own" });
  }

  // Resume
  if (!(await exists(RESUME_PATH))) {
    add({ id: "resume", label: "Resume", status: "warn", detail: `No resume.json at ${RESUME_PATH}`, fix: "Open the TUI (`resume`) and import or start one" });
  } else {
    try {
      const issues = lint(await load());
      const warns = issues.filter((i) => i.level === "warn").length;
      add({ id: "resume", label: "Resume", status: hasErrors(issues) ? "error" : warns ? "warn" : "ok", detail: hasErrors(issues) ? "has errors" : `valid${warns ? `, ${warns} warning(s)` : ""}`, fix: warns || hasErrors(issues) ? "See Issues, or `resume validate`" : undefined });
    } catch (e) {
      add({ id: "resume", label: "Resume", status: "error", detail: e instanceof Error ? e.message.split("\n")[0]! : String(e), fix: "Fix resume.json, or restore a backup" });
    }
  }

  // Privacy: personal files must not be committed.
  const git = await gitIgnored(home, ["resume.json", "applications/x", "variants/x.json", "reports/x.md", ".cache/x", ".env"]);
  if (!git.repo) add({ id: "git", label: "Privacy", status: "ok", detail: "Data folder isn't a git repo" });
  else if (git.exposed.length) {
    add({ id: "git", label: "Privacy", status: "error", detail: `Not gitignored: ${git.exposed.map((p) => p.replace(/\/x(\.\w+)?$/, "/")).join(", ")}`, fix: "Add them to .gitignore before committing" });
  } else add({ id: "git", label: "Privacy", status: "ok", detail: "Personal files are gitignored" });

  // PDF export
  const chrome = await puppeteer.executablePath();
  add(
    (await exists(chrome))
      ? { id: "chrome", label: "PDF export", status: "ok", detail: "Chrome installed for Puppeteer" }
      : { id: "chrome", label: "PDF export", status: "error", detail: "Chrome for Puppeteer is missing", fix: "Run `bunx puppeteer browsers install chrome`" },
  );

  // Tabstack
  const ts = process.env.TABSTACK_API_KEY;
  if (!ts) add({ id: "tabstack", label: "Tabstack", status: "warn", detail: "No key: web import, tailoring, refresh and research are off", fix: "Add your key in Settings, or TABSTACK_API_KEY in .env" });
  else if (opts.liveTabstack) {
    try {
      await tabstack().extract.markdown({ url: "https://example.com", effort: "min" });
      add({ id: "tabstack", label: "Tabstack", status: "ok", detail: `Key ${maskKey(ts)} works (used one Extract call)` });
    } catch (e) {
      add({ id: "tabstack", label: "Tabstack", status: "error", detail: `Key ${maskKey(ts)} failed: ${e instanceof Error ? e.message : e}`, fix: "Check the key in Settings" });
    }
  } else add({ id: "tabstack", label: "Tabstack", status: "ok", detail: `Key ${maskKey(ts)} (not tested: testing uses a paid call)` });

  // Claude
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  const profile = await exists(join(process.env.HOME ?? "", ".config", "anthropic"));
  if (!anthropicKey && !profile) {
    add({ id: "claude", label: "Claude", status: "info", detail: `Not set up: writing features use ${ts ? "Tabstack" : "nothing"}`, fix: "Add an Anthropic key in Settings, or run `ant auth login`" });
  } else if (opts.live) {
    try {
      // Token counting is free, so it's a no-cost key check.
      await new Anthropic().messages.countTokens({ model: "claude-opus-5-5", messages: [{ role: "user", content: "ping" }] });
      add({ id: "claude", label: "Claude", status: "ok", detail: `${anthropicKey ? `Key ${maskKey(anthropicKey)}` : "ant profile"} works` });
    } catch (e) {
      add({ id: "claude", label: "Claude", status: "error", detail: `Credentials failed: ${e instanceof Error ? e.message : e}`, fix: "Check the key in Settings" });
    }
  } else add({ id: "claude", label: "Claude", status: "ok", detail: anthropicKey ? `Key ${maskKey(anthropicKey)}` : "ant profile found" });

  // GitHub
  const token = await githubToken();
  if (opts.live) {
    try {
      const res = await fetch("https://api.github.com/rate_limit", { headers: { "User-Agent": "resume-manager", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      const core = ((await res.json()) as { resources?: { core?: { remaining: number; limit: number } } }).resources?.core;
      add({
        id: "github",
        label: "GitHub",
        status: !res.ok ? "error" : token ? "ok" : "warn",
        detail: res.ok ? `${token ? "Authenticated" : "Unauthenticated"}: ${core?.remaining}/${core?.limit} requests left this hour` : `GitHub returned ${res.status}`,
        fix: token ? undefined : "Run `gh auth login` or add a GitHub token in Settings (60/hour isn't enough for a scan)",
      });
    } catch (e) {
      add({ id: "github", label: "GitHub", status: "error", detail: `Can't reach GitHub: ${e instanceof Error ? e.message : e}` });
    }
  } else add({ id: "github", label: "GitHub", status: token ? "ok" : "warn", detail: token ? "Token found (GITHUB_TOKEN or gh)" : "No token: limited to 60 requests/hour", fix: token ? undefined : "Run `gh auth login`" });

  // GitLab (optional)
  const resumeForAccounts = await load().catch(() => undefined);
  const gitlabAccounts = resumeForAccounts ? accountsFromResume(resumeForAccounts).filter((a) => a.forge === "gitlab") : [];
  const glBase = gitlabAccounts[0]?.host ? gitlabBase(gitlabAccounts[0].host) : gitlabBase();
  const glToken = await gitlabToken(glBase);
  const glHost = new URL(glBase).host;
  if (!gitlabAccounts.length && !glToken) {
    add({ id: "gitlab", label: "GitLab", status: "info", detail: "No GitLab profile in your resume", fix: "Add a GitLab profile in Basics → Profiles to include it in scans" });
  } else if (opts.live) {
    try {
      const res = await fetch(`${glBase}/api/v4/${glToken ? "user" : "projects?per_page=1"}`, { headers: { "User-Agent": "resume-manager", ...(glToken ? { "PRIVATE-TOKEN": glToken } : {}) } });
      const remaining = res.headers.get("ratelimit-remaining");
      add({
        id: "gitlab",
        label: "GitLab",
        status: !res.ok ? "error" : glToken ? "ok" : "warn",
        detail: res.ok ? `${glHost}: ${glToken ? "token works" : "public access only"}${remaining ? `, ${remaining} requests left this minute` : ""}` : `${glHost} returned ${res.status}${glToken ? " (check the token)" : ""}`,
        fix: glToken ? undefined : "Add a GitLab token in Settings (or `glab auth login`) for fork detection and private projects",
      });
    } catch (e) {
      add({ id: "gitlab", label: "GitLab", status: "error", detail: `Can't reach ${glHost}: ${e instanceof Error ? e.message : e}` });
    }
  } else {
    add({ id: "gitlab", label: "GitLab", status: glToken ? "ok" : "warn", detail: `${glHost}: ${glToken ? `token ${maskKey(glToken)}` : "no token (public projects; forks can't be told apart)"}`, fix: glToken ? undefined : "Add a GitLab token in Settings, or run `glab auth login`" });
  }

  // Extras
  add((await which("unzip")) ? { id: "unzip", label: "LinkedIn .zip import", status: "ok", detail: "unzip available" } : { id: "unzip", label: "LinkedIn .zip import", status: "warn", detail: "unzip not found", fix: "Unzip the export yourself and import the folder" });
  const image = opts.imageProtocol ?? guessImageSupport();
  add({ id: "preview", label: "In-terminal PDF preview", status: image === "blocks" ? "info" : "ok", detail: image === "blocks" ? "Low-resolution blocks (this terminal has no image protocol)" : `Full resolution via ${image}`, fix: image === "blocks" ? "Kitty, Ghostty, WezTerm or iTerm2 show pages at full resolution" : undefined });

  const spend = await monthSpend();
  add({ id: "spend", label: "Spend", status: spend.budget !== undefined && spend.usd > spend.budget * 0.8 ? "warn" : "info", detail: describeSpend(spend), fix: spend.budget === undefined ? "Set a monthly budget in Settings to cap priced AI calls" : undefined });
  add({ id: "config", label: "Config file", status: "info", detail: CONFIG_FILE });
  return checks;
}

export const CHECK_ICON: Record<CheckStatus, string> = { ok: "✔", warn: "▲", error: "✖", info: "·" };
