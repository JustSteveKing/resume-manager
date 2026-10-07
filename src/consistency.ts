import type { Resume } from "./schema.ts";

// Consistency checks: tense, spelling variety, gaps, and title variants.

export interface Finding {
  level: "warn" | "info";
  message: string;
  index?: number;
}

// Present-tense openers that should be past tense on a finished role.
const PRESENT: Record<string, string> = {
  lead: "Led", manage: "Managed", build: "Built", design: "Designed", develop: "Developed", own: "Owned",
  run: "Ran", maintain: "Maintained", create: "Created", write: "Wrote", mentor: "Mentored", drive: "Drove",
  deliver: "Delivered", support: "Supported", oversee: "Oversaw", implement: "Implemented", architect: "Architected",
  establish: "Established", launch: "Launched", improve: "Improved", reduce: "Reduced", increase: "Increased",
  coordinate: "Coordinated", organise: "Organised", organize: "Organized", host: "Hosted", speak: "Spoke", grow: "Grew",
  leads: "Led", manages: "Managed", builds: "Built", designs: "Designed", develops: "Developed", owns: "Owned",
  runs: "Ran", maintains: "Maintained", creates: "Created", writes: "Wrote", mentors: "Mentored", drives: "Drove",
};

// [British, American] pairs; matched as word stems so "optimised"/"optimizing" count too.
const SPELLING: [RegExp, RegExp, string][] = [
  [/\boptimis/i, /\boptimiz/i, "optimise/optimize"],
  [/\borganis/i, /\borganiz/i, "organise/organize"],
  [/\bmodernis/i, /\bmoderniz/i, "modernise/modernize"],
  [/\bspecialis/i, /\bspecializ/i, "specialise/specialize"],
  [/\bprioritis/i, /\bprioritiz/i, "prioritise/prioritize"],
  [/\bstandardis/i, /\bstandardiz/i, "standardise/standardize"],
  [/\butilis/i, /\butiliz/i, "utilise/utilize"],
  [/\brecognis/i, /\brecogniz/i, "recognise/recognize"],
  [/\banalys(e|ed|ing)\b/i, /\banalyz/i, "analyse/analyze"],
  [/\bcolour/i, /\bcolor\b/i, "colour/color"],
  [/\bbehaviour/i, /\bbehavior/i, "behaviour/behavior"],
  [/\bcentre\b/i, /\bcenter\b/i, "centre/center"],
  [/\blicence\b/i, /\blicense\b/i, "licence/license (noun)"],
  [/\bcatalogue/i, /\bcatalog\b/i, "catalogue/catalog"],
  [/\bprogramme\b/i, /\bprogram\b(?! manager)/i, "programme/program"],
];

const lines = (r: Resume) =>
  [
    r.basics.summary,
    r.basics.label,
    ...r.work.flatMap((w) => [w.summary, ...(w.highlights ?? [])]),
    ...r.projects.flatMap((p) => [p.description, ...(p.highlights ?? [])]),
    ...r.publications.map((p) => p.summary),
    ...r.volunteer.flatMap((v) => [v.summary, ...(v.highlights ?? [])]),
  ].filter((s): s is string => !!s);

const monthIndex = (iso?: string) => {
  if (!iso) return undefined;
  const [y, m] = iso.split("-");
  return Number(y) * 12 + (m ? Number(m) - 1 : 0);
};

export function consistency(r: Resume, now = new Date()): Finding[] {
  const out: Finding[] = [];

  // Tense: finished roles shouldn't read as current.
  r.work.forEach((w, index) => {
    if (!w.endDate) return;
    for (const h of w.highlights ?? []) {
      const first = h.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
      if (PRESENT[first]) {
        out.push({ level: "warn", index, message: `${w.name}: "${h.slice(0, 40)}…" is present tense on a finished role (try "${PRESENT[first]}")` });
      }
    }
  });

  // Spelling: mixing British and American forms reads as careless.
  const text = lines(r).join("\n");
  let uk = 0;
  let us = 0;
  const usWords: string[] = [];
  const ukWords: string[] = [];
  for (const [ukRe, usRe, label] of SPELLING) {
    const a = (text.match(new RegExp(ukRe, "gi")) ?? []).length;
    const b = (text.match(new RegExp(usRe, "gi")) ?? []).length;
    uk += a;
    us += b;
    if (b) usWords.push(label.split("/")[1]!);
    if (a) ukWords.push(label.split("/")[0]!);
  }
  if (uk && us) {
    const [style, others] = uk >= us ? ["British", usWords] : ["American", ukWords];
    out.push({ level: "warn", message: `Mixed British and American spelling. Mostly ${style}; also found: ${others.join(", ")}` });
  }

  // Gaps: 6+ months with no role (concurrent roles cover each other).
  const spans = r.work
    .map((w) => ({ name: w.name, start: monthIndex(w.startDate), end: w.endDate ? monthIndex(w.endDate) : now.getFullYear() * 12 + now.getMonth() }))
    .filter((s): s is { name: string; start: number; end: number } => s.start !== undefined && s.end !== undefined)
    .sort((a, b) => a.start - b.start);
  let coveredUntil = spans[0]?.end ?? 0;
  let lastName = spans[0]?.name;
  for (const s of spans.slice(1)) {
    const gap = s.start - coveredUntil;
    if (gap >= 6) {
      out.push({ level: "info", message: `${gap}-month gap between ${lastName} and ${s.name}. Fine if deliberate; consider a line on what you did` });
    }
    if (s.end > coveredUntil) {
      coveredUntil = s.end;
      lastName = s.name;
    }
  }

  // Titles: the same title written two ways ("Tech Lead" / "Technical Lead", "Sr." / "Senior").
  const norm = (t: string) =>
    t.toLowerCase().replace(/\bsr\b\.?/g, "senior").replace(/\bjr\b\.?/g, "junior").replace(/\btech\b/g, "technical").replace(/\beng\b\.?/g, "engineer").replace(/[^a-z]/g, "");
  const byNorm = new Map<string, Set<string>>();
  for (const w of r.work) {
    if (!w.position) continue;
    const key = norm(w.position);
    byNorm.set(key, (byNorm.get(key) ?? new Set()).add(w.position));
  }
  for (const variants of byNorm.values()) {
    if (variants.size > 1) out.push({ level: "info", message: `Same title written differently: ${[...variants].map((v) => `"${v}"`).join(" and ")}` });
  }
  return out;
}
