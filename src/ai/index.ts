import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { checkBudget, claudeCost, estimateClaude, record } from "../costs.ts";
import { CACHE_DIR } from "../paths.ts";
import type { Resume } from "../schema.ts";
import { tabstack, toTabstackSchema } from "../tabstack.ts";

// One small interface for every writing feature (coach, interviewer, interview prep), so features
// don't care which model runs them and tests can inject a fake.

export interface AiRequest<T extends z.ZodType> {
  schema: T;
  /** Stable instructions: role, rules, tone. */
  system: string;
  /** The task and its facts. */
  prompt: string;
}

export interface AI {
  name: "claude" | "tabstack";
  json<T extends z.ZodType>(req: AiRequest<T>): Promise<z.infer<T>>;
}

export const MODEL = "claude-opus-5-5";

/** Shared rules for anything that writes resume copy. */
export const WRITING_RULES = `Rules:
- Use only facts given to you. Never invent employers, numbers, dates, tools or outcomes.
- Every number you write must appear in the facts.
- Plain, specific, confident. No clichés ("passionate", "cutting-edge", "robust", "seamless", "leveraged").
- Lead with a strong past-tense verb for finished roles, present tense for current ones.
- British English.`;

// ---------- Claude ----------

class ClaudeAI implements AI {
  name = "claude" as const;
  private client = new Anthropic();

  async json<T extends z.ZodType>(req: AiRequest<T>): Promise<z.infer<T>> {
    await checkBudget(estimateClaude(req.system.length + req.prompt.length), "Claude request");
    const res = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // Refused requests are re-run on a fallback model chosen by refusal category.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { effort: "medium", format: betaZodOutputFormat(req.schema) },
    });
    await record({
      service: "claude",
      op: "json",
      model: res.model,
      usd: claudeCost(res.model, res.usage),
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    });
    if (res.stop_reason === "refusal") {
      throw new Error(`Claude declined this request${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ""}`);
    }
    if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off (max_tokens). Try a shorter input.");
    if (res.parsed_output == null) throw new Error("Claude returned output that didn't match the expected shape");
    return res.parsed_output as z.infer<T>;
  }
}

// ---------- Tabstack fallback ----------

const TABSTACK_LIMIT = 20_000;

/** Tabstack generate always fetches a page; point it at the candidate's own site so the page is harmless context. */
class TabstackAI implements AI {
  name = "tabstack" as const;
  constructor(private contextUrl: string) {}

  async json<T extends z.ZodType>(req: AiRequest<T>): Promise<z.infer<T>> {
    const instructions = `${req.system}\n\nIgnore the fetched page unless it helps; the task is below.\n\n${req.prompt}`;
    if (instructions.length > TABSTACK_LIMIT) {
      throw new Error(`Request is ${instructions.length} characters; Tabstack allows ${TABSTACK_LIMIT}. Set ANTHROPIC_API_KEY to use Claude instead.`);
    }
    const res = await tabstack().generate.json({ url: this.contextUrl, instructions, json_schema: toTabstackSchema(req.schema) });
    return req.schema.parse(res);
  }
}

// ---------- caching + selection ----------

/** Cache answers by exact request, so re-asking the same thing (same text, same facts) costs nothing. */
export function cached(ai: AI, dir = join(CACHE_DIR, "ai")): AI {
  return {
    name: ai.name,
    async json(req) {
      const key = Bun.hash(JSON.stringify([ai.name, MODEL, req.system, req.prompt, z.toJSONSchema(req.schema)])).toString(16);
      const file = Bun.file(join(dir, `${key}.json`));
      if (await file.exists()) {
        const hit = req.schema.safeParse(await file.json());
        if (hit.success) return hit.data;
      }
      const res = await ai.json(req);
      await Bun.write(file, JSON.stringify(res, null, 2));
      return res;
    },
  };
}

/** Anthropic credentials: an env key/token, or an `ant auth login` profile on disk. */
async function hasClaudeCredentials(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  try {
    return (await readdir(join(homedir(), ".config", "anthropic"))).length > 0;
  } catch {
    return false;
  }
}

export type AiChoice = "auto" | "claude" | "tabstack";

/**
 * Pick the writing model: Claude when credentials exist (best writing), else Tabstack generate
 * (needs TABSTACK_API_KEY and a URL in basics: website or GitHub profile). RESUME_AI forces one.
 */
export async function getAI(r?: Resume, choice: AiChoice = (process.env.RESUME_AI as AiChoice) ?? "auto"): Promise<AI> {
  if (choice === "claude" || (choice === "auto" && (await hasClaudeCredentials()))) return cached(new ClaudeAI());
  const url = r?.basics.url ?? r?.basics.profiles?.find((p) => p.url)?.url;
  if ((choice === "tabstack" || choice === "auto") && process.env.TABSTACK_API_KEY && url) return cached(new TabstackAI(url));
  throw new Error(
    "No AI configured. Set ANTHROPIC_API_KEY (or run `ant auth login`) for Claude, or TABSTACK_API_KEY plus a website in Basics for Tabstack.",
  );
}
