import { join } from "node:path";
import { analyze, type RepoAnalysis } from "./repos/analyze.ts";
import { accountsFromResume, mergeData } from "./forges/index.ts";
import { CACHE_DIR } from "./paths.ts";
import { type RepoData } from "./repos/types.ts";
import { mentions, suggestSkills } from "./keywords.ts";
import type { Resume } from "./schema.ts";

// Skill evidence map: for every skill, what in the resume (and GitHub) backs it up.

export interface Proof {
  kind: "role" | "project" | "talk" | "repo" | "language";
  label: string;
  /** ISO date of the most recent use this proof shows. */
  when?: string;
}

export interface SkillEvidence {
  skill: string;
  group?: string;
  listed: boolean;
  proofs: Proof[];
  lastUsed?: string;
  status: "strong" | "ok" | "weak" | "unsupported" | "stale" | "unlisted";
}

const STALE_YEARS = 3;

const latest = (dates: (string | undefined)[]) => dates.filter((d): d is string => !!d).sort().at(-1);

// ---------- loose matching ----------
// Evidence needs looser matching than ATS keywords: "Technical Writing" is backed by a
// "Technical Writer" role, "Conference Speaking" by "Spoke at 15+ conferences".

const IRREGULAR: Record<string, string> = {
  spoke: "speak", spoken: "speak", wrote: "write", written: "write", led: "lead", built: "build",
  ran: "run", taught: "teach", grew: "grow", drove: "drive", made: "make", gave: "give",
};
const SUFFIXES = ["ations", "ation", "ments", "ment", "ings", "ing", "ists", "ist", "isms", "ism", "ers", "er", "ated", "ates", "ate", "acy", "ed", "es", "s"];
const STOP = new Set(["and", "of", "the", "for", "with", "in", "to", "on", "a", "an"]);

export function stem(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z0-9+#.]/g, "");
  w = IRREGULAR[w] ?? w;
  for (const suffix of SUFFIXES) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w;
}

const stems = (text: string) => new Set(text.split(/[^A-Za-z0-9+#.]+/).filter(Boolean).map(stem));

/**
 * Ways a listed skill can appear in text:  "Laravel 11" -> Laravel; "Vue.js" -> Vue.js, Vue;
 * "Domain-Driven Design (DDD)" -> Domain-Driven Design, DDD; "AWS (EC2, RDS)" -> AWS, EC2, RDS.
 */
export function skillForms(skill: string): string[] {
  const inParens = [...skill.matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1]!.split(/[,/]/)).map((x) => x.trim());
  const base = skill
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(v?\d+(\.[\dx]+)*\+?|ES\d+\+?)(?![\w.])/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const noJs = base.replace(/\.js$/i, "");
  return [...new Set([skill, base, noJs, ...inParens].filter((f) => f && f.length > 1))];
}

/** Exact keyword match (with aliases), or every meaningful word of the skill appearing in the same text. */
export function supports(text: string | undefined, skill: string): boolean {
  if (!text) return false;
  const forms = skillForms(skill);
  if (forms.length > 1) return forms.some((f) => supportsForm(text, f));
  return supportsForm(text, skill);
}

function supportsForm(text: string, skill: string): boolean {
  if (mentions(text, skill)) return true;
  const words = skill.split(/[^A-Za-z0-9+#.]+/).filter((w) => w && !STOP.has(w.toLowerCase()));
  if (words.length < 2) return false; // single words must match exactly: "Go" mustn't match "going"
  const have = stems(text);
  return words.every((w) => have.has(stem(w)));
}

/** Cached GitHub/GitLab scans for the resume's accounts, merged (run `cv scan` to create them). */
export async function cachedRepos(r: Resume): Promise<RepoAnalysis | undefined> {
  const datas: RepoData[] = [];
  for (const a of accountsFromResume(r)) {
    const path = a.forge === "github" ? join(CACHE_DIR, "github", `${a.username.toLowerCase()}.json`) : join(CACHE_DIR, "gitlab", a.host ?? "gitlab.com", `${a.username.toLowerCase()}.json`);
    const file = Bun.file(path);
    if (await file.exists()) datas.push((await file.json()) as RepoData);
  }
  return datas.length ? analyze(mergeData(datas)) : undefined;
}


function proofsFor(skill: string, r: Resume, gh?: RepoAnalysis): Proof[] {
  const proofs: Proof[] = [];
  const has = (text: string | undefined) => supports(text, skill);
  for (const w of r.work) {
    if ([w.summary, ...(w.highlights ?? []), w.position].some(has)) {
      proofs.push({ kind: "role", label: [w.position, w.name].filter(Boolean).join(" @ "), when: w.endDate ?? new Date().toISOString().slice(0, 10) });
    }
  }
  for (const p of r.projects) {
    if ([p.description, ...(p.highlights ?? []), ...(p.keywords ?? []), p.name].some(has)) {
      proofs.push({ kind: "project", label: p.name, when: p.endDate ?? p.startDate });
    }
  }
  for (const p of r.publications) {
    if ([p.name, p.summary].some(has)) proofs.push({ kind: "talk", label: p.name, when: p.releaseDate });
  }
  if (gh) {
    const names = new Set(skillForms(skill).map((f) => f.toLowerCase()));
    const lang = gh.languages.find((l) => names.has(l.name.toLowerCase()));
    if (lang) proofs.push({ kind: "language", label: `${lang.repos} repos`, when: lang.lastUsed.slice(0, 10) });
    const tool = gh.tools.find((t) => names.has(t.name.toLowerCase()));
    if (tool) proofs.push({ kind: "repo", label: `${tool.repos.length} repo${tool.repos.length === 1 ? "" : "s"} (${tool.repos.slice(0, 3).join(", ")})`, when: tool.lastUsed.slice(0, 10) });
  }
  return proofs;
}

function status(listed: boolean, proofs: Proof[], lastUsed: string | undefined, now: Date): SkillEvidence["status"] {
  if (!listed) return "unlisted";
  if (!proofs.length) return "unsupported";
  if (lastUsed && (now.getTime() - Date.parse(lastUsed)) / (365 * 864e5) > STALE_YEARS) return "stale";
  const kinds = new Set(proofs.map((p) => p.kind)).size;
  if (proofs.length >= 3 && kinds >= 2) return "strong";
  return proofs.length >= 2 ? "ok" : "weak";
}

/**
 * Evidence for every listed skill, plus skills with evidence that aren't listed
 * (mentioned in the resume, or used in GitHub repos).
 */
export function evidenceMap(r: Resume, gh?: RepoAnalysis, now = new Date()): SkillEvidence[] {
  const out: SkillEvidence[] = [];
  const seen = new Set<string>();
  for (const group of r.skills) {
    for (const skill of group.keywords?.length ? group.keywords : [group.name]) {
      const key = skill.toLowerCase();
      if (seen.has(key)) continue;
      skillForms(skill).forEach((f) => seen.add(f.toLowerCase()));
      const proofs = proofsFor(skill, r, gh);
      const lastUsed = latest(proofs.map((p) => p.when));
      out.push({ skill, group: group.name, listed: true, proofs, lastUsed, status: status(true, proofs, lastUsed, now) });
    }
  }
  // Unlisted but evidenced: resume mentions (suggestSkills) and GitHub dependencies/languages used in 2+ repos.
  const candidates = [
    ...suggestSkills(r).flatMap((g) => (g.keywords ?? []).map((k) => [k, g.name] as const)),
    ...(gh?.tools.filter((t) => t.source === "dependency" && t.repos.length >= 2).map((t) => [t.name, "From GitHub"] as const) ?? []),
    ...(gh?.languages.filter((l) => l.repos >= 3).map((l) => [l.name, "Languages"] as const) ?? []),
  ];
  for (const [skill, group] of candidates) {
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const proofs = proofsFor(skill, r, gh);
    if (!proofs.length) continue;
    out.push({ skill, group, listed: false, proofs, lastUsed: latest(proofs.map((p) => p.when)), status: "unlisted" });
  }
  const order = { unsupported: 0, stale: 1, weak: 2, unlisted: 3, ok: 4, strong: 5 };
  return out.sort((a, b) => order[a.status] - order[b.status] || b.proofs.length - a.proofs.length);
}

export const STATUS_TEXT: Record<SkillEvidence["status"], string> = {
  strong: "strong: several kinds of proof",
  ok: "ok",
  weak: "weak: only one mention",
  unsupported: "listed, but nothing backs it up",
  stale: `no evidence in the last ${STALE_YEARS} years`,
  unlisted: "evidenced but not listed",
};

export function describeEvidence(e: SkillEvidence): string {
  const kinds = Object.entries(
    e.proofs.reduce<Record<string, number>>((acc, p) => ((acc[p.kind] = (acc[p.kind] ?? 0) + 1), acc), {}),
  ).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`);
  return `${kinds.join(", ") || "no proof"}${e.lastUsed ? `, last ${e.lastUsed.slice(0, 4)}` : ""}`;
}
