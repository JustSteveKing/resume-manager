import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BLOCK_IDS, type BlockId, type ResumeView } from "./export/blocks.ts";
import { score } from "./keywords.ts";
import type { Resume, Work } from "./schema.ts";
import { compareRecent, sortRecent } from "./sort.ts";
import { prune } from "./store.ts";

export const VARIANTS_DIR = process.env.RESUME_VARIANTS_DIR ?? "variants";

const count = z.number().int().nonnegative();

/**
 * A variant is a recipe for a shorter, targeted resume built from the full resume.json.
 * Stored as variants/<name>.json.
 */
export const Variant = z.object({
  label: z.string().optional(),
  description: z.string().optional(),

  // Selection
  /** Keep tagged entries only if they have one of these tags. Untagged entries are always kept. */
  tags: z.array(z.string()).optional(),
  /** Drop entries with any of these tags. */
  excludeTags: z.array(z.string()).optional(),
  /** Rank roles, highlights, projects and talks by how many of these they mention. */
  keywords: z.array(z.string()).optional(),
  /** Blocks to show, in order. Defaults to everything. */
  blocks: z.array(z.enum(BLOCK_IDS)).optional(),
  maxRoles: count.optional(),
  maxHighlights: count.optional(),
  maxProjects: count.optional(),
  maxPublications: count.optional(),
  /** Keywords kept per skill group (most relevant first when keywords are set). */
  maxSkillKeywords: count.optional(),
  /** Roles that ended before this date (YYYY or YYYY-MM) become one-line "Earlier career" entries. */
  earlierCareerBefore: z.string().optional(),
  /** Hide role summaries when the role has highlights. */
  dropRoleSummaries: z.boolean().optional(),

  // Overrides
  basics: z.object({ label: z.string().optional(), summary: z.string().optional() }).optional(),

  // Output
  theme: z.string().optional(),
  accent: z.string().optional(),
  paper: z.enum(["A4", "Letter"]).optional(),
  /** Warn (or with fit, trim) when the PDF exceeds this many pages. */
  targetPages: count.optional(),
  /** Automatically tighten limits until the PDF fits targetPages. */
  fit: z.boolean().optional(),

  /** Where a tailored variant came from. */
  job: z.object({ url: z.string(), title: z.string().optional(), company: z.string().optional() }).optional(),
});

export type Variant = z.infer<typeof Variant>;

// ---------- storage ----------

export const variantPath = (name: string) => join(VARIANTS_DIR, `${name}.json`);

export async function listVariants(): Promise<string[]> {
  try {
    return (await readdir(VARIANTS_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

export async function loadVariant(name: string): Promise<Variant> {
  const file = Bun.file(variantPath(name));
  if (!(await file.exists())) throw new Error(`No variant "${name}" (looked for ${variantPath(name)})`);
  const parsed = Variant.safeParse(await file.json());
  if (!parsed.success) throw new Error(`${variantPath(name)} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function saveVariant(name: string, v: Variant) {
  await Bun.write(variantPath(name), JSON.stringify(prune(Variant.parse(v)), null, 2) + "\n");
}

export const deleteVariant = (name: string) => unlink(variantPath(name));

export const variantSlug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "variant";

// ---------- applying ----------

type Tagged = { tags?: string[] };

const tagFilter = (v: Variant) => (item: Tagged) => {
  if (v.excludeTags?.some((t) => item.tags?.includes(t))) return false;
  if (!v.tags?.length || !item.tags?.length) return true;
  return item.tags.some((t) => v.tags!.includes(t));
};

const textOf = (item: object) =>
  Object.entries(item)
    .filter(([k]) => !/url|date|tags/i.test(k))
    .map(([, x]) => (Array.isArray(x) ? x.join(" ") : String(x)))
    .join(" ");

/** Pick the n most relevant items (keyword score, then recency) and return them in date order. */
function pickTop<T extends object>(items: T[], n: number | undefined, keywords: string[]): { kept: T[]; dropped: T[] } {
  if (n === undefined || items.length <= n) return { kept: items, dropped: [] };
  const ranked = [...items].sort(
    (a, b) => score(textOf(b), keywords) - score(textOf(a), keywords) || compareRecent(a, b),
  );
  const keep = new Set(ranked.slice(0, n));
  return { kept: items.filter((i) => keep.has(i)), dropped: items.filter((i) => !keep.has(i)) };
}

/** Stable sort of strings by keyword relevance, most relevant first. */
/** A quantified bullet ("20 thousand users", "40%") beats a vague one when space is short. */
const strength = (h: string) => (/\d/.test(h) ? 1 : 0);

/**
 * Most relevant first (keyword hits), then quantified before vague; otherwise the author's order.
 * Stable, so with nothing to go on nothing moves.
 */
const rankStrings = (items: string[] | undefined, keywords: string[]) =>
  items && [...items].sort((a, b) => (keywords.length ? score(b, keywords) - score(a, keywords) : 0) || strength(b) - strength(a));

export function applyVariant(full: Resume, v: Variant = {}): ResumeView {
  const r = structuredClone(full) as ResumeView;
  const keep = tagFilter(v);
  const kw = v.keywords ?? [];

  for (const key of ["work", "volunteer", "projects", "publications", "skills"] as const) {
    (r[key] as Tagged[]) = (r[key] as Tagged[]).filter(keep);
  }

  // Work: split off earlier career, pick the most relevant roles, rank and trim highlights.
  sortRecent(r.work);
  let earlier: Work[] = [];
  if (v.earlierCareerBefore) {
    const cutoff = v.earlierCareerBefore;
    earlier = r.work.filter((w) => w.endDate && w.endDate < cutoff);
    r.work = r.work.filter((w) => !earlier.includes(w));
  }
  const roles = pickTop(r.work, v.maxRoles, kw);
  r.work = roles.kept;
  earlier = sortRecent([...roles.dropped, ...earlier]);

  for (const w of r.work) {
    w.highlights = rankStrings(w.highlights, kw)?.slice(0, v.maxHighlights);
    if (v.dropRoleSummaries && w.highlights?.length) delete w.summary;
  }
  for (const p of r.projects) p.highlights = rankStrings(p.highlights, kw)?.slice(0, v.maxHighlights);

  r.projects = pickTop(r.projects, v.maxProjects, kw).kept;
  r.publications = pickTop(r.publications, v.maxPublications, kw).kept;
  if (kw.length) r.skills = [...r.skills].sort((a, b) => score(textOf(b), kw) - score(textOf(a), kw));
  if (v.maxSkillKeywords !== undefined) {
    for (const g of r.skills) g.keywords = rankStrings(g.keywords, kw)?.slice(0, v.maxSkillKeywords);
  }

  if (v.basics?.label) r.basics.label = v.basics.label;
  if (v.basics?.summary) r.basics.summary = v.basics.summary;

  r.earlierCareer = earlier.length ? earlier : undefined;
  r.blockOrder = v.blocks?.length ? v.blocks : undefined;
  return r;
}

/** Plain JSON Resume for a view: earlier roles are kept as bare entries, render extras removed. */
export function viewToResume(view: ResumeView): Resume {
  const { earlierCareer, blockOrder, ...r } = view;
  const earlier = (earlierCareer ?? []).map(({ name, position, startDate, endDate, url }) => ({
    name, position, startDate, endDate, url,
  }));
  return { ...r, work: sortRecent([...r.work, ...earlier]) };
}

// ---------- fitting ----------

// ---------- fitting ----------

type Step = { set: Partial<Variant>; step: string; applies: (v: Variant, r: Resume) => boolean };

const lower = (key: "maxHighlights" | "maxPublications" | "maxProjects" | "maxRoles", n: number, step: string): Step => ({
  set: { [key]: n },
  step,
  applies: (v, r) => {
    const current = v[key];
    const natural =
      key === "maxRoles" ? r.work.length
      : key === "maxProjects" ? r.projects.length
      : key === "maxPublications" ? r.publications.length
      : Math.max(0, ...r.work.map((w) => w.highlights?.length ?? 0));
    return (current ?? natural) > n;
  },
});

// Least painful first, alternating between depth (highlights) and breadth (roles, talks).
const DEFAULT_BLOCKS = BLOCK_IDS.filter((b) => b !== "contact");
const visibleBlocks = (v: Variant) => v.blocks ?? DEFAULT_BLOCKS;
const dropBlock = (block: BlockId, step: string): Step => ({
  set: {},
  step,
  applies: (v, r) => visibleBlocks(v).includes(block) && hasContent(r, block),
});
const hasContent = (r: Resume, block: BlockId) =>
  ({ references: r.references, interests: r.interests, volunteer: r.volunteer, awards: [...r.awards, ...r.certificates], languages: r.languages } as Record<string, unknown[]>)[block]?.length !== 0;
const skillCap = (n: number, step: string): Step => ({
  set: { maxSkillKeywords: n },
  step,
  applies: (v, r) => (v.maxSkillKeywords ?? Math.max(0, ...r.skills.map((g) => g.keywords?.length ?? 0))) > n,
});

/** Steps that remove a whole section, by step label. */
const DROPS: Record<string, BlockId> = {
  "drop Interests": "interests",
  "drop Volunteering": "volunteer",
  "drop Awards & Certificates": "awards",
};

// Least painful first. Peripheral sections and long skill lists go before experience detail;
// "max 1 highlight per role" is the last resort.
const STEPS: Step[] = [
  dropBlock("interests", "drop Interests"),
  { set: { dropRoleSummaries: true }, step: "hide role summaries", applies: (v) => !v.dropRoleSummaries },
  skillCap(8, "max 8 skills per group"),
  lower("maxHighlights", 4, "max 4 highlights per role"),
  lower("maxPublications", 8, "max 8 talks/articles"),
  lower("maxProjects", 3, "max 3 projects"),
  dropBlock("volunteer", "drop Volunteering"),
  lower("maxHighlights", 3, "max 3 highlights per role"),
  lower("maxRoles", 8, "max 8 full roles (rest as earlier career)"),
  skillCap(5, "max 5 skills per group"),
  lower("maxPublications", 5, "max 5 talks/articles"),
  dropBlock("awards", "drop Awards & Certificates"),
  lower("maxRoles", 6, "max 6 full roles"),
  lower("maxHighlights", 2, "max 2 highlights per role"),
  lower("maxPublications", 3, "max 3 talks/articles"),
  lower("maxRoles", 5, "max 5 full roles"),
  lower("maxRoles", 4, "max 4 full roles"),
  lower("maxHighlights", 1, "max 1 highlight per role"),
];

/**
 * Progressively tighter versions of a variant, for squeezing a resume onto fewer pages.
 * Each step keeps every earlier tightening and adds one more.
 */
export function* tighten(base: Variant, full: Resume): Generator<{ variant: Variant; step: string }> {
  let v: Variant = { ...base };
  for (const s of STEPS) {
    if (!s.applies(v, full)) continue;
    const drop = DROPS[s.step];
    v = drop ? { ...v, blocks: visibleBlocks(v).filter((b) => b !== drop) } : { ...v, ...s.set };
    yield { variant: v, step: s.step };
  }
}
