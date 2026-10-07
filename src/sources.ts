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

const norm = (v: unknown) => String(v ?? "").toLowerCase().trim();
const nameOf = (i: Item) => norm(i.name ?? i.title ?? i.institution ?? i.organization ?? i.language);
const sameIdentity = (a: Item, b: Item) => (!!nameOf(a) && nameOf(a) === nameOf(b)) || (!!a.url && a.url === b.url);
// Roles: a missing position or start date on either side doesn't count as a difference.
const sameRole = (a: Item, b: Item) =>
  (!a.position || !b.position || norm(a.position) === norm(b.position)) &&
  (!a.startDate || !b.startDate || String(a.startDate).slice(0, 4) === String(b.startDate).slice(0, 4));

/**
 * Is this item already in the resume? Same display title, or same name/URL and the same role
 * (position and start year). Two roles at one company are not duplicates.
 */
export function isDuplicate(section: Section, existing: Item[], item: Item): boolean {
  const title = norm(section.title(item));
  return existing.some((e) => norm(section.title(e)) === title || (sameIdentity(e, item) && sameRole(e, item)));
}

/** An entry with the same name/URL but a different role or start: maybe the same job retitled, maybe a second role. */
export function findSimilar(section: Section, existing: Item[], item: Item): Item | undefined {
  if (isDuplicate(section, existing, item)) return undefined;
  return existing.find((e) => sameIdentity(e, item));
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
