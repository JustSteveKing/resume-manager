import { Basics, type Resume, type Source } from "./schema.ts";
import { SECTIONS, type Section } from "./sections.ts";
import { extractItems, extractObject } from "./tabstack.ts";

type Item = Record<string, any>;

export const sourceLabel = (s: Source) => `${new URL(s.url).hostname}${new URL(s.url).pathname} → ${s.target}`;

export function saveSource(r: Resume, source: Source) {
  const sources = (r.meta?.sources ?? []).filter((s) => !(s.url === source.url && s.target === source.target));
  r.meta = { ...r.meta, sources: [...sources, source] };
}

export function removeSource(r: Resume, source: Source) {
  r.meta = { ...r.meta, sources: (r.meta?.sources ?? []).filter((s) => s !== source) };
}

/** Is this extracted item already in the resume? Matches on display title or URL. */
export function isDuplicate(section: Section, existing: Item[], item: Item): boolean {
  const title = section.title(item).toLowerCase();
  const name = String(item.name ?? item.title ?? item.institution ?? item.organization ?? "").toLowerCase();
  return existing.some(
    (e) =>
      section.title(e).toLowerCase() === title ||
      (!!item.url && e.url === item.url) ||
      (!!name && String(e.name ?? e.title ?? e.institution ?? e.organization ?? "").toLowerCase() === name),
  );
}

export type RefreshResult =
  | { source: Source; kind: "items"; section: Section; fresh: Item[]; skipped: number }
  | { source: Source; kind: "basics"; found: Partial<Basics> }
  | { source: Source; kind: "error"; error: string };

/** Re-run every saved source and return only entries not already in the resume. */
export async function refreshSources(r: Resume, onStart?: (s: Source) => void): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];
  for (const source of r.meta?.sources ?? []) {
    onStart?.(source);
    try {
      if (source.target === "basics") {
        results.push({ source, kind: "basics", found: await extractObject(source.url, Basics, source.effort) });
      } else {
        const section = SECTIONS.find((s) => s.key === source.target);
        if (!section) throw new Error(`Unknown section "${source.target}"`);
        const { valid, invalid } = await extractItems(source.url, section.schema, source.effort);
        const existing = r[section.key] as Item[];
        const fresh = (valid as Item[]).filter((i) => !isDuplicate(section, existing, i));
        results.push({ source, kind: "items", section, fresh, skipped: invalid.length });
      }
      source.lastRun = new Date().toISOString();
    } catch (e) {
      results.push({ source, kind: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
