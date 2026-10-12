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
  name: "ollama" | "claude" | "tabstack";
  /** Model that answers, when it isn't the Claude default (part of the cache key). */
  model?: string;
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

// ---------- Ollama (local, default) ----------

export const OLLAMA_MODEL = "qwen3:8b";
export const ollamaHost = () => (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "");
export const ollamaModel = () => process.env.OLLAMA_MODEL || OLLAMA_MODEL;

/** Models Ollama has pulled, or undefined when it isn't running. Local and free, so safe to probe. */
export async function ollamaModels(host = ollamaHost()): Promise<string[] | undefined> {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
    return ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  } catch {
    return undefined;
  }
}

/** "qwen3" is pulled as "qwen3:latest". */
export const hasModel = (models: string[], model: string) => models.some((m) => m === model || m === `${model}:latest`);

/** Local model via Ollama's chat API, with the schema as a structured-output format. No spend to record. */
class OllamaAI implements AI {
  name = "ollama" as const;
  constructor(
    public model = ollamaModel(),
    private host = ollamaHost(),
  ) {}

  async json<T extends z.ZodType>(req: AiRequest<T>): Promise<z.infer<T>> {
    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          // Thinking models (qwen3…) are many times slower with it and the schema keeps answers on track.
          think: false,
          format: z.toJSONSchema(req.schema),
          options: { temperature: 0.4 },
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        }),
      });
    } catch {
      throw new Error(`Ollama isn't running at ${this.host}. Start it with \`ollama serve\`, or choose another AI in Settings.`);
    }
    if (!res.ok) {
      const detail = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText;
      throw new Error(`Ollama (${this.model}): ${detail}${res.status === 404 ? `. Run \`ollama pull ${this.model}\`` : ""}`);
    }
    const content = ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Ollama (${this.model}) returned output that wasn't JSON`);
    }
    const out = req.schema.safeParse(parsed);
    if (!out.success) throw new Error(`Ollama (${this.model}) returned output that didn't match the expected shape`);
    return out.data;
  }
}

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
    model: ai.model,
    async json(req) {
      const key = Bun.hash(JSON.stringify([ai.name, ai.model ?? MODEL, req.system, req.prompt, z.toJSONSchema(req.schema)])).toString(16);
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

export type AiChoice = "auto" | "ollama" | "claude" | "tabstack";

/**
 * Pick the writing model: a local Ollama model when Ollama is running (free, private), else Claude
 * when credentials exist, else Tabstack generate (needs TABSTACK_API_KEY and a URL in basics:
 * website or GitHub profile). RESUME_AI forces one.
 */
export async function getAI(r?: Resume, choice: AiChoice = (process.env.RESUME_AI as AiChoice) || "auto"): Promise<AI> {
  if (choice === "ollama") return cached(new OllamaAI());
  if (choice === "auto") {
    const models = await ollamaModels();
    if (models) {
      // Ollama is running but the model isn't pulled: say so rather than quietly switching to a paid model.
      if (!hasModel(models, ollamaModel())) {
        throw new Error(`Ollama is running but ${ollamaModel()} isn't pulled. Run \`ollama pull ${ollamaModel()}\`, set another model in Settings, or choose Claude.`);
      }
      return cached(new OllamaAI());
    }
  }
  if (choice === "claude" || (choice === "auto" && (await hasClaudeCredentials()))) return cached(new ClaudeAI());
  const url = r?.basics.url ?? r?.basics.profiles?.find((p) => p.url)?.url;
  if ((choice === "tabstack" || choice === "auto") && process.env.TABSTACK_API_KEY && url) return cached(new TabstackAI(url));
  throw new Error(
    "No AI configured. Start Ollama (`ollama serve`) for a local model, set ANTHROPIC_API_KEY (or run `ant auth login`) for Claude, or TABSTACK_API_KEY plus a website in Basics for Tabstack.",
  );
}
