import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.ts";

// Spend ledger and budget cap. Claude calls are priced exactly from token usage; Tabstack's SDK
// doesn't publish per-call prices, so Extract/Generate calls are counted, and Research is priced
// at the SDK-documented fast-mode rate.

const cacheDir = () => process.env.RESUME_CACHE_DIR ?? ".cache";
const ledgerFile = () => join(cacheDir(), "spend.json");

/** $ per million tokens (Anthropic first-party rates). Fallbacks can serve a different model, so price by the model that ran. */
export const CLAUDE_PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

export const TABSTACK_RESEARCH_FAST_USD = 2;

const Entry = z.object({
  at: z.string(),
  service: z.enum(["claude", "tabstack"]),
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

export function claudeCost(model: string, usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null }): number | undefined {
  const p = CLAUDE_PRICES[model.replace(/-\d{8}$/, "")];
  if (!p) return undefined;
  return ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output + (usage.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6;
}

/** Rough pre-call estimate for one Claude writing request: ~4 chars per token in, ~2.5k tokens out (incl. thinking). */
export function estimateClaude(promptChars: number, model = "claude-opus-5-5"): number {
  return claudeCost(model, { input_tokens: Math.ceil(promptChars / 4) + 400, output_tokens: 2500 }) ?? 0;
}

export interface MonthSpend {
  month: string;
  usd: number;
  claudeCalls: number;
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
    claudeCalls: entries.filter((e) => e.service === "claude").length,
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
      `${what} (≈${formatUsd(estimateUsd)}) would exceed your monthly budget: ${formatUsd(s.usd)} of ${formatUsd(s.budget)} used. Raise it in Settings or with \`resume config budget <usd>\`.`,
    );
  }
}

export const formatUsd = (n: number) => (n < 0.01 ? `${Math.max(0, Math.round(n * 1000) / 10)}¢` : n < 1 ? `${Math.round(n * 100)}¢` : `$${n.toFixed(2)}`);

export function describeSpend(s: MonthSpend): string {
  const parts = [`${formatUsd(s.usd)} this month (${s.month})`];
  if (s.budget !== undefined) parts.push(`budget ${formatUsd(s.budget)}`);
  parts.push(`${s.claudeCalls} Claude call(s), ${s.tabstackCalls} Tabstack call(s)`);
  if (s.unpriced) parts.push(`${s.unpriced} unpriced`);
  return parts.join(" · ");
}
