import { join } from "node:path";
import { z } from "zod";
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
  name: "ollama" | "tabstack";
  /** Model that answers (part of the cache key). */
  model?: string;
  json<T extends z.ZodType>(req: AiRequest<T>): Promise<z.infer<T>>;
}

/** Shared rules for anything that writes resume copy. */
export const WRITING_RULES = `Rules:
- Use only facts given to you. Never invent employers, numbers, dates, tools or outcomes.
- Every number you write must appear in the facts.
- Plain, specific, confident. No clichés ("passionate", "cutting-edge", "robust", "seamless", "leveraged").
- Lead with a strong past-tense verb for finished roles, present tense for current ones.
- British English.`;

// ---------- Ollama (local, default) ----------

export const OLLAMA_MODEL = "qwen3:8b";
export const OLLAMA_HOST = "http://localhost:11434";

/**
 * Accept OLLAMA_HOST the way Ollama does ("0.0.0.0", "127.0.0.1:11434", "gpu-box"): add the scheme and
 * default port, and connect locally when it names the listen-on-everything address.
 */
export function normalizeOllamaHost(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return OLLAMA_HOST;
  try {
    // Like Ollama: a bare host gets port 11434; an explicit http:// or https:// keeps its usual port.
    const bare = !/^https?:\/\//i.test(value);
    const url = new URL(bare ? `http://${value}` : value);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1";
    if (bare && !/^(\[[^\]]*\]|[^/]*?):\d+(\/|$)/.test(value)) url.port = "11434";
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

export const ollamaHost = () => normalizeOllamaHost(process.env.OLLAMA_HOST);
export const ollamaModel = () => process.env.OLLAMA_MODEL?.trim() || OLLAMA_MODEL;

/**
 * Is Ollama there? "down" (nothing listening: fine to use another AI) is kept apart from "unresponsive"
 * (it's there but slow or failing), so a busy Ollama never quietly hands work to a paid model.
 */
export type OllamaStatus = { state: "running"; models: string[] } | { state: "down" } | { state: "unresponsive"; reason: string };

const probes = new Map<string, { at: number; status: Promise<OllamaStatus> }>();
const PROBE_TTL = 15_000;

/** Local and free, so safe to call often; getAI reuses a result for 15s, the doctor asks fresh. */
export function probeOllama(host = ollamaHost(), opts: { fresh?: boolean; timeoutMs?: number } = {}): Promise<OllamaStatus> {
  const hit = probes.get(host);
  if (!opts.fresh && hit && Date.now() - hit.at < PROBE_TTL) return hit.status;
  const status = (async (): Promise<OllamaStatus> => {
    try {
      const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) });
      if (!res.ok) return { state: "unresponsive", reason: `HTTP ${res.status}` };
      return { state: "running", models: ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [] };
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") return { state: "unresponsive", reason: "timed out" };
      return { state: "down" };
    }
  })();
  probes.set(host, { at: Date.now(), status });
  return status;
}

/** "qwen3" is pulled as "qwen3:latest". */
export const hasModel = (models: string[], model: string) => models.some((m) => m === model || m === `${model}:latest`);

/**
 * Ollama's default context is small and it silently drops the *start* of a long prompt (the rules).
 * Size it for the request: ~3 chars per token for prompt and schema, plus room for the answer.
 */
function contextFor(req: AiRequest<z.ZodType>): number {
  const chars = req.system.length + req.prompt.length + JSON.stringify(z.toJSONSchema(req.schema)).length;
  const tokens = Math.ceil(chars / 3) + 4096;
  return Math.min(32_768, Math.max(8192, Math.ceil(tokens / 2048) * 2048));
}

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
          options: { temperature: 0.4, num_ctx: contextFor(req) },
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

// ---------- Tabstack (opt-in) ----------

const TABSTACK_LIMIT = 20_000;

/** Tabstack generate always fetches a page; point it at the candidate's own site so the page is harmless context. */
class TabstackAI implements AI {
  name = "tabstack" as const;
  constructor(private contextUrl: string) {}

  async json<T extends z.ZodType>(req: AiRequest<T>): Promise<z.infer<T>> {
    const instructions = `${req.system}\n\nIgnore the fetched page unless it helps; the task is below.\n\n${req.prompt}`;
    if (instructions.length > TABSTACK_LIMIT) {
      throw new Error(`Request is ${instructions.length} characters; Tabstack allows ${TABSTACK_LIMIT}. Use Ollama instead (\`cv config ai auto\`).`);
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
      const key = Bun.hash(JSON.stringify([ai.name, ai.model ?? "", req.system, req.prompt, z.toJSONSchema(req.schema)])).toString(16);
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

/** No AI is set up at all (as opposed to one that's set up but failing). Callers with a fallback catch only this. */
export class NoAIError extends Error {}

export type AiChoice = "auto" | "ollama" | "tabstack";

/**
 * Pick the writing model. Writing stays local: a model on Ollama, unless Tabstack generate is chosen
 * explicitly (needs TABSTACK_API_KEY and a URL in basics: website or GitHub profile). Nothing falls back
 * to a cloud model on its own. RESUME_AI forces one.
 */
export async function getAI(r?: Resume, choice: AiChoice = (process.env.RESUME_AI as AiChoice) || "auto"): Promise<AI> {
  if (choice === "tabstack") {
    const url = r?.basics.url ?? r?.basics.profiles?.find((p) => p.url)?.url;
    if (process.env.TABSTACK_API_KEY && url) return cached(new TabstackAI(url));
    throw new NoAIError("Tabstack is chosen for writing but needs TABSTACK_API_KEY and a website in Basics. Or use Ollama: `cv config ai auto`.");
  }
  if (choice === "ollama") return cached(new OllamaAI());
  const ollama = await probeOllama();
  if (ollama.state === "down") {
    throw new NoAIError(`Ollama isn't running at ${ollamaHost()}. Start it with \`ollama serve\`.`);
  }
  if (ollama.state === "unresponsive") {
    throw new Error(`Ollama at ${ollamaHost()} isn't responding (${ollama.reason}). Try again, or restart Ollama.`);
  }
  if (!hasModel(ollama.models, ollamaModel())) {
    throw new Error(`Ollama is running but ${ollamaModel()} isn't pulled. Run \`ollama pull ${ollamaModel()}\`, or set another model in Settings.`);
  }
  return cached(new OllamaAI());
}
