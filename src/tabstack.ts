import Tabstack from "@tabstack/sdk";
import { z } from "zod";
import { checkBudget, record, TABSTACK_RESEARCH_FAST_USD } from "./costs.ts";
import { normaliseDates } from "./dates.ts";
import { prune } from "./store.ts";

let client: Tabstack | undefined;
let clientKey: string | undefined;

/** Price per call where known (USD); undefined = counted but unpriced. */
const METERED: Record<string, Record<string, number | undefined>> = {
  extract: { json: undefined, markdown: undefined },
  generate: { json: undefined },
  agent: { research: TABSTACK_RESEARCH_FAST_USD, automate: undefined },
};

/** Wrap SDK resources so every call is checked against the budget and recorded in the spend ledger. */
export function metered(c: Tabstack): Tabstack {
  return new Proxy(c, {
    get(target, prop, receiver) {
      const resource = Reflect.get(target, prop, receiver);
      const ops = typeof prop === "string" ? METERED[prop] : undefined;
      if (!ops || !resource) return resource;
      return new Proxy(resource, {
        get(res, name, r) {
          const fn = Reflect.get(res, name, r);
          if (typeof name !== "string" || !(name in ops) || typeof fn !== "function") return fn;
          const op = `${String(prop)}.${name}`;
          const usd = ops[name];
          return async (...args: unknown[]) => {
            if (usd) await checkBudget(usd, `Tabstack ${op}`);
            const out = await fn.apply(res, args);
            await record({ service: "tabstack", op, usd });
            return out;
          };
        },
      });
    },
  });
}

export function tabstack() {
  const key = process.env.TABSTACK_API_KEY;
  if (!key) throw new Error("TABSTACK_API_KEY is not set. Add it in Settings, or to .env.");
  // A key changed in Settings takes effect without a restart.
  if (!client || clientKey !== key) {
    client = metered(new Tabstack({ apiKey: key }));
    clientKey = key;
  }
  return client;
}

export type Effort = "min" | "standard" | "max";

// Zod -> plain JSON Schema that Tabstack accepts (no $schema, no strict additionalProperties).
export function toTabstackSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  return stripKeys(json, new Set(["$schema", "additionalProperties", "pattern"]));
}

function stripKeys(value: any, keys: Set<string>): any {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, keys));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !keys.has(k))
        .map(([k, v]) => [k, stripKeys(v, keys)]),
    );
  }
  return value;
}

export interface ExtractResult<T> {
  valid: T[];
  invalid: { item: unknown; error: string }[];
}

/** Extract a list of section entries (work, projects, talks...) from a page. */
export async function extractItems<T extends z.ZodObject>(
  url: string,
  item: T,
  effort: Effort = "standard",
): Promise<ExtractResult<z.infer<T>>> {
  const wrapper = z.object({
    items: z.array(withoutTags(item)).describe("Every matching entry found on the page"),
  });
  const res = await tabstack().extract.json({
    url,
    effort,
    json_schema: toTabstackSchema(wrapper),
  });

  const raw = Array.isArray(res.items) ? res.items : [];
  const out: ExtractResult<z.infer<T>> = { valid: [], invalid: [] };
  for (const entry of raw) {
    const parsed = item.safeParse(prune(normaliseDates(entry ?? {})));
    if (parsed.success) out.valid.push(parsed.data);
    else out.invalid.push({ item: entry, error: z.prettifyError(parsed.error) });
  }
  return out;
}

/** Extract a single object (e.g. basics) from a page. */
export async function extractObject<T extends z.ZodObject>(
  url: string,
  schema: T,
  effort: Effort = "standard",
): Promise<Partial<z.infer<T>>> {
  const res = await tabstack().extract.json({
    url,
    effort,
    json_schema: toTabstackSchema(withoutTags(schema)),
  });
  // Keep whatever fields validate; drop the rest rather than failing the whole import.
  const parsed = schema.partial().safeParse(prune(res));
  if (parsed.success) return parsed.data as Partial<z.infer<T>>;
  const ok: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(prune(res))) {
    const field = schema.shape[key] as z.ZodType | undefined;
    if (field?.safeParse(value).success) ok[key] = value;
  }
  return ok as Partial<z.infer<T>>;
}

// Tags are a local curation concept; never ask Tabstack to invent them.
function withoutTags<T extends z.ZodObject>(schema: T): z.ZodObject {
  return "tags" in schema.shape ? schema.omit({ tags: true } as never) : schema;
}
