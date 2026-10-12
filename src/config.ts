import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

// User config (~/.config/resume-manager/config.json): where your resume lives, API keys, AI choice
// and budget. Kept outside any repo. This module must not import other app modules: cli.ts loads it
// first so the paths it sets are in place before anything reads them.

export const CONFIG_DIR = process.env.RESUME_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "resume-manager");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const Config = z.object({
  /** Folder holding resume.json, variants/, applications/, dist/… */
  home: z.string().optional(),
  ai: z.enum(["auto", "ollama", "tabstack"]).optional(),
  /** Local model via Ollama (default http://localhost:11434, qwen3:8b). */
  ollama: z.object({ host: z.string().optional(), model: z.string().optional() }).optional(),
  keys: z
    .object({ tabstack: z.string().optional(), github: z.string().optional(), gitlab: z.string().optional() })
    .optional(),
  /** Monthly cap on priced Tabstack spend (Research), in US dollars. */
  budget: z.object({ monthlyUsd: z.number().positive().optional() }).optional(),
  /** Self-hosted GitLab, e.g. "https://gitlab.example.com" (default gitlab.com). */
  gitlab: z.object({ host: z.string().optional() }).optional(),
  preview: z.object({ protocol: z.enum(["auto", "kitty", "sixel", "blocks"]).optional() }).optional(),
});
export type Config = z.infer<typeof Config>;

export async function loadConfig(): Promise<Config> {
  const f = Bun.file(CONFIG_FILE);
  if (!(await f.exists())) return {};
  const parsed = Config.safeParse(await f.json().catch(() => ({})));
  return parsed.success ? parsed.data : {};
}

/** Save with owner-only permissions: the file can hold API keys. */
export async function saveConfig(c: Config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await Bun.write(CONFIG_FILE, JSON.stringify(Config.parse(c), null, 2) + "\n");
  await chmod(CONFIG_FILE, 0o600);
}

export async function updateConfig(fn: (c: Config) => void): Promise<Config> {
  const c = await loadConfig();
  fn(c);
  await saveConfig(c);
  return c;
}

export type HomeSource = "RESUME_HOME" | "current folder" | "config" | "default";

/** Which folder to use: RESUME_HOME, else the current folder if it has a resume.json, else the configured home, else cwd. */
export async function resolveHome(cwd = process.cwd(), config?: Config): Promise<{ home: string; source: HomeSource }> {
  if (process.env.RESUME_HOME) return { home: resolve(process.env.RESUME_HOME), source: "RESUME_HOME" };
  if (await Bun.file(join(cwd, "resume.json")).exists()) return { home: cwd, source: "current folder" };
  const c = config ?? (await loadConfig());
  if (c.home) return { home: c.home, source: "config" };
  return { home: cwd, source: "default" };
}

/** Parse a .env file (KEY=value, # comments, optional quotes). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const setDefault = (key: string, value: string | undefined) => {
  if (value && !process.env[key]) process.env[key] = value;
};

/**
 * Point every module at the resolved home and load keys. Anything already set in the
 * environment wins, so RESUME_PATH etc. still override.
 */
export async function applyEnvironment(cwd = process.cwd()): Promise<{ home: string; source: HomeSource; config: Config }> {
  const config = await loadConfig();
  const { home, source } = await resolveHome(cwd, config);
  setDefault("RESUME_HOME", home);
  setDefault("RESUME_HOME_SOURCE", source);
  setDefault("RESUME_PATH", join(home, "resume.json"));
  setDefault("RESUME_OUT_DIR", join(home, "dist"));
  setDefault("RESUME_VARIANTS_DIR", join(home, "variants"));
  setDefault("RESUME_APPLICATIONS_DIR", join(home, "applications"));
  setDefault("RESUME_REPORTS_DIR", join(home, "reports"));
  setDefault("RESUME_CACHE_DIR", join(home, ".cache"));
  // Bun only auto-loads .env from the current folder; also read the home folder's.
  if (home !== cwd) {
    const env = Bun.file(join(home, ".env"));
    if (await env.exists()) for (const [k, v] of Object.entries(parseDotenv(await env.text()))) setDefault(k, v);
  }
  setDefault("TABSTACK_API_KEY", config.keys?.tabstack);
  setDefault("GITHUB_TOKEN", config.keys?.github);
  setDefault("GITLAB_TOKEN", config.keys?.gitlab);
  setDefault("GITLAB_HOST", config.gitlab?.host);
  setDefault("OLLAMA_HOST", config.ollama?.host);
  setDefault("OLLAMA_MODEL", config.ollama?.model);
  if (config.ai && config.ai !== "auto") setDefault("RESUME_AI", config.ai);
  return { home, source, config };
}

/** Show a key's presence without revealing it: "sk-a…9f2c". */
export const maskKey = (k?: string) => (!k ? "not set" : k.length <= 10 ? "set" : `${k.slice(0, 4)}…${k.slice(-4)}`);
