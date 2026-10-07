import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadVariant } from "./variants.ts";

// Application tracker: applications/<slug>/application.json, one per tailored job.

export const APPLICATIONS_DIR = process.env.RESUME_APPLICATIONS_DIR ?? "applications";

export const STATUSES = ["draft", "applied", "interview", "offer", "rejected", "withdrawn"] as const;
export type Status = (typeof STATUSES)[number];

export const Application = z.object({
  slug: z.string(),
  title: z.string().optional(),
  company: z.string().optional(),
  url: z.string().optional(),
  /** Variant used for this application (variants/<name>.json). */
  variant: z.string().optional(),
  /** Keyword coverage when tailored, 0-1. */
  coverage: z.number().optional(),
  status: z.enum(STATUSES),
  history: z.array(z.object({ status: z.enum(STATUSES), date: z.string() })),
  followUp: z.string().optional().describe("YYYY-MM-DD"),
  notes: z.string().optional(),
  createdAt: z.string(),
});
export type Application = z.infer<typeof Application>;

const file = (slug: string) => join(APPLICATIONS_DIR, slug, "application.json");
const today = () => new Date().toISOString().slice(0, 10);

export async function loadApplication(slug: string): Promise<Application | undefined> {
  const f = Bun.file(file(slug));
  if (!(await f.exists())) return undefined;
  const parsed = Application.safeParse(await f.json());
  return parsed.success ? parsed.data : undefined;
}

export async function saveApplicationRecord(a: Application) {
  await Bun.write(file(a.slug), JSON.stringify(Application.parse(a), null, 2) + "\n");
}

/** Create the record for a newly tailored job (kept as-is if it already exists). */
export async function ensureApplication(init: Omit<Application, "status" | "history" | "createdAt">): Promise<Application> {
  const existing = await loadApplication(init.slug);
  if (existing) return existing;
  const a: Application = { ...init, status: "draft", history: [{ status: "draft", date: today() }], createdAt: today() };
  await saveApplicationRecord(a);
  return a;
}

export async function listApplications(): Promise<Application[]> {
  let dirs: string[] = [];
  try {
    dirs = await readdir(APPLICATIONS_DIR);
  } catch {
    return [];
  }
  const out: Application[] = [];
  for (const slug of dirs) {
    const a = await loadApplication(slug);
    if (a) out.push(a);
    else if (await Bun.file(join(APPLICATIONS_DIR, slug, "job.md")).exists()) {
      // Older tailor runs only wrote job.md: adopt them as drafts.
      const job = await Bun.file(join(APPLICATIONS_DIR, slug, "job.md")).text();
      const title = job.match(/^# (.+)$/m)?.[1];
      const url = job.match(/^Source: (\S+)/m)?.[1];
      const coverage = Number(job.match(/Keyword coverage: (\d+)%/)?.[1]);
      out.push(await ensureApplication({ slug, title, url, variant: slug, coverage: Number.isFinite(coverage) ? coverage / 100 : undefined }));
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function setStatus(a: Application, status: Status, date = today()): Promise<Application> {
  const next = { ...a, status, history: [...a.history, { status, date }] };
  // Applying is when a follow-up becomes useful; default it to a week later.
  if (status === "applied" && !next.followUp) next.followUp = addDays(date, 7);
  if (status === "offer" || status === "rejected" || status === "withdrawn") delete next.followUp;
  await saveApplicationRecord(next);
  return next;
}

export const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);

export const followUpsDue = (apps: Application[], on = today()) =>
  apps.filter((a) => a.followUp && a.followUp <= on && (a.status === "applied" || a.status === "interview"));

// ---------- learning ----------

const responded = (a: Application) => a.history.some((h) => h.status === "interview" || h.status === "offer");
const sent = (a: Application) => a.status !== "draft" && a.status !== "withdrawn";

export interface Stat {
  key: string;
  sent: number;
  responses: number;
  rate: number;
}

function groupStats(apps: Application[], keyOf: (a: Application) => string | undefined): Stat[] {
  const groups = new Map<string, Application[]>();
  for (const a of apps.filter(sent)) {
    const key = keyOf(a) ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups]
    .map(([key, list]) => {
      const responses = list.filter(responded).length;
      return { key, sent: list.length, responses, rate: list.length ? responses / list.length : 0 };
    })
    .sort((a, b) => b.rate - a.rate || b.sent - a.sent);
}

const coverageBucket = (a: Application) =>
  a.coverage === undefined ? undefined : a.coverage >= 0.7 ? "70%+ keyword coverage" : a.coverage >= 0.5 ? "50-69% coverage" : "under 50% coverage";

export interface Learning {
  total: number;
  sent: number;
  responses: number;
  byVariant: Stat[];
  byTheme: Stat[];
  byCoverage: Stat[];
  /** Plain-language takeaways, only when there's enough data. */
  insights: string[];
}

export async function learn(apps: Application[]): Promise<Learning> {
  const themes = new Map<string, string | undefined>();
  for (const a of apps) {
    if (a.variant && !themes.has(a.variant)) themes.set(a.variant, await loadVariant(a.variant).then((v) => v.theme ?? "classic", () => undefined));
  }
  const byVariant = groupStats(apps, (a) => a.variant);
  const byTheme = groupStats(apps, (a) => (a.variant ? themes.get(a.variant) : undefined));
  const byCoverage = groupStats(apps, coverageBucket);
  const s = apps.filter(sent);
  const insights: string[] = [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const best = (stats: Stat[]) => stats.filter((x) => x.sent >= 3);
  for (const [label, stats] of [["Variant", byVariant], ["Theme", byTheme], ["Coverage", byCoverage]] as const) {
    const enough = best(stats);
    if (enough.length >= 2 && enough[0]!.rate > enough.at(-1)!.rate) {
      insights.push(`${label}: "${enough[0]!.key}" gets responses ${pct(enough[0]!.rate)} of the time vs ${pct(enough.at(-1)!.rate)} for "${enough.at(-1)!.key}"`);
    }
  }
  if (!insights.length && s.length < 6) insights.push(`Send a few more (${s.length} so far) before reading anything into the numbers; comparisons need 3+ per group.`);
  return { total: apps.length, sent: s.length, responses: s.filter(responded).length, byVariant, byTheme, byCoverage, insights };
}
