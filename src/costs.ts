import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.ts";

// Spend ledger and budget cap. Writing runs locally on Ollama (free), so only Tabstack is here. Its SDK
// doesn't publish per-call prices, so Extract/Generate calls are counted, and Research is priced
// at the SDK-documented fast-mode rate.

const cacheDir = () => process.env.RESUME_CACHE_DIR ?? ".cache";
const ledgerFile = () => join(cacheDir(), "spend.json");

export const TABSTACK_RESEARCH_FAST_USD = 2;

const Entry = z.object({
  at: z.string(),
  service: z.literal("tabstack"),
  op: z.string(),
  usd: z.number().optional(),
  model: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});
export type Entry = z.infer<typeof Entry>;

async function readLedger(): Promise<Entry[]> {
  const f = Bun.file(ledgerFile());
  if (!(await f.exists())) return [];
  const parsed = z.array(Entry).safeParse(await f.json().catch(() => []));
  return parsed.success ? parsed.data : [];
}

// Serialise writes: several calls can finish at once.
let writing = Promise.resolve();
export function record(entry: Omit<Entry, "at">): Promise<void> {
  writing = writing.then(async () => {
    const all = await readLedger();
    all.push({ ...entry, at: new Date().toISOString() });
    await Bun.write(ledgerFile(), JSON.stringify(all, null, 2) + "\n");
  });
  return writing;
}

export interface MonthSpend {
  month: string;
  usd: number;
  tabstackCalls: number;
  /** Calls with no published price (Tabstack Extract/Generate). */
  unpriced: number;
  budget?: number;
}

export async function monthSpend(now = new Date()): Promise<MonthSpend> {
  const month = now.toISOString().slice(0, 7);
  const entries = (await readLedger()).filter((e) => e.at.startsWith(month));
  const budget = (await loadConfig()).budget?.monthlyUsd;
  return {
    month,
    usd: entries.reduce((n, e) => n + (e.usd ?? 0), 0),
    tabstackCalls: entries.filter((e) => e.service === "tabstack").length,
    unpriced: entries.filter((e) => e.usd === undefined).length,
    budget,
  };
}

export class BudgetError extends Error {}

/** Refuse a priced call that would take this month over the configured cap. */
export async function checkBudget(estimateUsd: number, what: string) {
  const s = await monthSpend();
  if (s.budget !== undefined && s.usd + estimateUsd > s.budget) {
    throw new BudgetError(
      `${what} (≈${formatUsd(estimateUsd)}) would exceed your monthly budget: ${formatUsd(s.usd)} of ${formatUsd(s.budget)} used. Raise it in Settings or with \`cv config budget <usd>\`.`,
    );
  }
}

export const formatUsd = (n: number) => (n < 0.01 ? `${Math.max(0, Math.round(n * 1000) / 10)}¢` : n < 1 ? `${Math.round(n * 100)}¢` : `$${n.toFixed(2)}`);

export function describeSpend(s: MonthSpend): string {
  const parts = [`${formatUsd(s.usd)} this month (${s.month})`];
  if (s.budget !== undefined) parts.push(`budget ${formatUsd(s.budget)}`);
  parts.push(`${s.tabstackCalls} Tabstack call(s)`);
  if (s.unpriced) parts.push(`${s.unpriced} unpriced`);
  return parts.join(" · ");
}
