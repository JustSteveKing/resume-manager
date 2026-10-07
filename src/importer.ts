import { z } from "zod";
import { normaliseDate } from "./dates.ts";
import { isLinkedInExport, linkedInToJsonResume } from "./linkedin.ts";
import { Basics, Resume } from "./schema.ts";
import { SECTIONS, type SectionKey } from "./sections.ts";
import { findSimilar, isDuplicate } from "./sources.ts";
import { prune, RESUME_PATH, save } from "./store.ts";

// Import an existing JSON Resume (file, URL, gist or registry.jsonresume.org username).

type Raw = Record<string, any>;

export interface ImportReport {
  source: string;
  resume: Resume;
  /** Fields our schema doesn't know, e.g. "work[2].pinned". They are not imported. */
  dropped: string[];
  /** Entries that failed validation even after normalising. */
  invalid: { path: string; error: string }[];
  /** Legacy fields renamed, dates rewritten, etc. */
  fixes: string[];
}

// ---------- reading ----------

/** Resolve shorthand: registry usernames and gist URLs → fetchable raw JSON. */
export async function resolveSource(input: string): Promise<{ kind: "file" | "url"; location: string }> {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    const gist = s.match(/^https?:\/\/gist\.github\.com\/(?:[\w-]+\/)?([0-9a-f]+)/i);
    if (gist) return { kind: "url", location: `https://api.github.com/gists/${gist[1]}` };
    const registry = s.match(/^https?:\/\/registry\.jsonresume\.org\/([\w-]+)\/?$/i);
    if (registry) return { kind: "url", location: `https://registry.jsonresume.org/${registry[1]}.json` };
    return { kind: "url", location: s };
  }
  if (await Bun.file(s).exists()) return { kind: "file", location: s };
  // A bare word that isn't a file: treat as a registry.jsonresume.org username.
  if (/^[\w-]+$/.test(s)) return { kind: "url", location: `https://registry.jsonresume.org/${s}.json` };
  throw new Error(`No such file: ${s}`);
}

// YAML would read `startDate: 2020-01` as the number 2020. Quote date-like values first.
const quoteYamlDates = (text: string) =>
  text.replace(/^(\s*-?\s*\w*[dD]ate\s*:\s*)(\d{4}(?:-\d{2}){0,2})\s*$/gm, '$1"$2"');

export function parseText(text: string, hint = ""): unknown {
  const trimmed = text.trimStart();
  if (/\.ya?ml$/i.test(hint) || (!trimmed.startsWith("{") && /^\w+\s*:/m.test(trimmed))) {
    return Bun.YAML.parse(quoteYamlDates(text));
  }
  return JSON.parse(text);
}

export async function readSource(input: string): Promise<{ raw: unknown; source: string }> {
  // LinkedIn "Download your data": a .zip or an unzipped folder of CSVs.
  if (await isLinkedInExport(input.trim())) return { raw: await linkedInToJsonResume(input.trim()), source: `LinkedIn export (${input.trim()})` };
  const src = await resolveSource(input);
  if (src.kind === "file") return { raw: parseText(await Bun.file(src.location).text(), src.location), source: src.location };

  const res = await fetch(src.location, { headers: { Accept: "application/json, text/yaml, */*" } });
  if (!res.ok) throw new Error(`${res.status} fetching ${src.location}`);
  const text = await res.text();
  if (src.location.startsWith("https://api.github.com/gists/")) {
    const files = (JSON.parse(text) as { files: Record<string, { filename: string; content: string }> }).files;
    const file = Object.values(files).find((f) => /^resume\.(json|ya?ml)$/i.test(f.filename)) ?? Object.values(files)[0];
    if (!file) throw new Error("Gist has no files");
    return { raw: parseText(file.content, file.filename), source: `${input} (${file.filename})` };
  }
  if (/^\s*</.test(text)) throw new Error(`${src.location} returned HTML, not a resume. Link to the raw JSON file.`);
  return { raw: parseText(text, src.location), source: src.location };
}

// ---------- normalising ----------

// Renames from older JSON Resume drafts (v0.0.0 and popular forks) to the current schema.
const RENAMES: Partial<Record<SectionKey | "basics", Record<string, string>>> = {
  basics: { website: "url", picture: "image" },
  work: { company: "name", website: "url" },
  volunteer: { website: "url" },
  education: { gpa: "score", website: "url" },
  publications: { website: "url" },
  awards: {},
  projects: { website: "url" },
};

const DATE_KEY = /(^date$|Date$)/;

function shapeKeys(schema: z.ZodObject): Set<string> {
  return new Set(Object.keys(schema.shape));
}

/** Rename legacy keys, coerce dates, and collect fields the schema would silently strip. */
export function normalise(raw: unknown): { data: Raw; dropped: string[]; fixes: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Not a JSON Resume: expected an object");
  const input = raw as Raw;
  const data: Raw = {};
  const dropped: string[] = [];
  const fixes: string[] = [];

  const fixItem = (item: Raw, path: string, renames: Record<string, string>, known: Set<string>) => {
    const out: Raw = {};
    for (const [key, value] of Object.entries(item ?? {})) {
      const target = renames[key] && !(renames[key]! in item) ? renames[key]! : key;
      if (target !== key) fixes.push(`${path}.${key} → ${target}`);
      if (!known.has(target)) {
        dropped.push(`${path}.${key}`);
        continue;
      }
      if (DATE_KEY.test(target) && value !== undefined && value !== null) {
        const iso = normaliseDate(String(value));
        if (iso !== value) fixes.push(`${path}.${target}: ${JSON.stringify(value)} → ${iso ?? "(removed)"}`);
        out[target] = iso;
      } else out[target] = value;
    }
    return out;
  };

  const basicsKnown = shapeKeys(Basics);
  if (input.basics) {
    data.basics = fixItem(input.basics, "basics", RENAMES.basics ?? {}, basicsKnown);
    // Very old drafts put location fields directly on basics or used a string.
    if (typeof data.basics.location === "string") {
      fixes.push(`basics.location: "${data.basics.location}" → { city }`);
      data.basics.location = { city: data.basics.location };
    }
  }

  for (const s of SECTIONS) {
    const list = input[s.key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      dropped.push(`${s.key} (not a list)`);
      continue;
    }
    data[s.key] = list.map((item, i) => fixItem(item, `${s.key}[${i}]`, RENAMES[s.key] ?? {}, shapeKeys(s.schema)));
  }

  const known = new Set(["$schema", "basics", "meta", ...SECTIONS.map((s) => s.key)]);
  for (const key of Object.keys(input)) if (!known.has(key)) dropped.push(key);
  for (const key of Object.keys(input.meta ?? {})) if (!["canonical", "version", "lastModified"].includes(key)) dropped.push(`meta.${key}`);
  return { data, dropped, fixes };
}

/** Validate entry by entry so one bad item doesn't block the rest. */
export function toResume(source: string, raw: unknown): ImportReport {
  const { data, dropped, fixes } = normalise(raw);
  const invalid: ImportReport["invalid"] = [];
  const out: Raw = {};

  const basics = Basics.safeParse(prune(data.basics ?? {}));
  if (basics.success) out.basics = basics.data;
  else {
    // Keep the fields that validate on their own.
    out.basics = {};
    for (const [k, v] of Object.entries(prune(data.basics ?? {}))) {
      const field = Basics.shape[k as keyof typeof Basics.shape] as z.ZodType | undefined;
      if (field?.safeParse(v).success) out.basics[k] = v;
      else invalid.push({ path: `basics.${k}`, error: "invalid value" });
    }
  }

  for (const s of SECTIONS) {
    out[s.key] = [];
    (data[s.key] as Raw[] | undefined)?.forEach((item, i) => {
      const parsed = s.schema.safeParse(prune(item));
      if (parsed.success) out[s.key].push(parsed.data);
      else invalid.push({ path: `${s.key}[${i}]`, error: z.prettifyError(parsed.error).replace(/\s+/g, " ") });
    });
  }
  return { source, resume: Resume.parse(out), dropped, invalid, fixes };
}

export async function importJsonResume(input: string): Promise<ImportReport> {
  const { raw, source } = await readSource(input);
  return toResume(source, raw);
}

// ---------- merging ----------

type Item = Record<string, any>;

export interface MergePlan {
  /** New (non-duplicate) entries per section. `similar` names an existing entry it might duplicate. */
  add: { section: SectionKey; item: Item; label: string; similar?: string }[];
  /** Entries already in the resume. */
  duplicates: { section: SectionKey; label: string }[];
  /** Basics fields that are empty in the current resume and present in the import. */
  fillBasics: Partial<Resume["basics"]>;
  /** Basics fields that differ (not applied automatically). */
  conflicts: { key: string; current: unknown; incoming: unknown }[];
}

export function planMerge(current: Resume, incoming: Resume): MergePlan {
  const plan: MergePlan = { add: [], duplicates: [], fillBasics: {}, conflicts: [] };
  for (const s of SECTIONS) {
    const existing = current[s.key] as Item[];
    const accepted: Item[] = [];
    for (const item of incoming[s.key] as Item[]) {
      const label = s.title(item) || "(untitled)";
      // Check against both the resume and entries already accepted from this import.
      if (isDuplicate(s, [...existing, ...accepted], item)) plan.duplicates.push({ section: s.key, label });
      else {
        const similar = findSimilar(s, existing, item);
        accepted.push(item);
        plan.add.push({ section: s.key, item, label, similar: similar ? s.title(similar) : undefined });
      }
    }
  }
  const cur = current.basics as Item;
  for (const [key, value] of Object.entries(incoming.basics as Item)) {
    if (key === "profiles") continue;
    const empty = cur[key] === undefined || cur[key] === "" || (typeof cur[key] === "object" && !Object.keys(cur[key]).length);
    if (empty) (plan.fillBasics as Item)[key] = value;
    else if (JSON.stringify(cur[key]) !== JSON.stringify(value)) plan.conflicts.push({ key, current: cur[key], incoming: value });
  }
  const knownProfiles = new Set((current.basics.profiles ?? []).map((p) => (p.url ?? p.network ?? "").toLowerCase()));
  const newProfiles = (incoming.basics.profiles ?? []).filter((p) => !knownProfiles.has((p.url ?? p.network ?? "").toLowerCase()));
  if (newProfiles.length) plan.fillBasics.profiles = [...(current.basics.profiles ?? []), ...newProfiles];
  return plan;
}

/** Apply a plan to a resume in place. By default possible duplicates are skipped; pass `pick` to choose. */
export function applyMerge(r: Resume, plan: MergePlan, pick: (entry: MergePlan["add"][number]) => boolean = (e) => !e.similar) {
  for (const entry of plan.add) if (pick(entry)) (r[entry.section] as Item[]).push(entry.item);
  r.basics = { ...r.basics, ...plan.fillBasics };
}

export function describeImport(report: ImportReport, plan?: MergePlan): string[] {
  const counts = SECTIONS.map((s) => [s.label, (report.resume[s.key] as Item[]).length] as const).filter(([, n]) => n);
  const lines = [
    `Source: ${report.source}`,
    `${report.resume.basics.name ?? "(no name)"}: ${counts.map(([l, n]) => `${n} ${l.toLowerCase()}`).join(", ") || "no entries"}`,
  ];
  if (report.fixes.length) lines.push(`Fixed ${report.fixes.length}: ${report.fixes.slice(0, 6).join("; ")}${report.fixes.length > 6 ? "; …" : ""}`);
  if (report.dropped.length) lines.push(`Not imported (unknown fields): ${report.dropped.slice(0, 8).join(", ")}${report.dropped.length > 8 ? ", …" : ""}`);
  if (report.invalid.length) lines.push(...report.invalid.map((i) => `Invalid ${i.path}: ${i.error}`));
  if (plan) {
    const similar = plan.add.filter((a) => a.similar);
    lines.push(`Merge: ${plan.add.length - similar.length} new, ${similar.length} possible duplicate(s), ${plan.duplicates.length} already in resume`);
    similar.forEach((a) => lines.push(`Possible duplicate: ${a.label} ~ ${a.similar}`));
    const fills = Object.keys(plan.fillBasics);
    if (fills.length) lines.push(`Fills empty basics: ${fills.join(", ")}`);
    if (plan.conflicts.length) lines.push(`Kept your basics (differ in import): ${plan.conflicts.map((c) => c.key).join(", ")}`);
  }
  return lines;
}

/** The import, keeping this tool's own settings (PDF preferences, saved sources) from the current resume. */
export const replacement = (current: Resume, incoming: Resume): Resume => ({
  ...incoming,
  meta: { ...incoming.meta, pdf: current.meta?.pdf, sources: current.meta?.sources },
});

/** Write `resume.backup-<timestamp>.json` next to the resume (matches the /resume.*.json gitignore rule). */
export async function backupResume(current: Resume, path = RESUME_PATH): Promise<string> {
  const backup = path.replace(/\.json$/, "") + `.backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await Bun.write(backup, JSON.stringify(current, null, 2) + "\n");
  return backup;
}

/** Back up, then replace the resume file with the import. */
export async function replaceResume(current: Resume, incoming: Resume, path = RESUME_PATH): Promise<string> {
  const backup = await backupResume(current, path);
  await save(replacement(current, incoming), path);
  return backup;
}
