import { z } from "zod";
import { Resume } from "./schema.ts";
import { SECTIONS, type SectionKey } from "./sections.ts";
import { consistency } from "./consistency.ts";
import { isSortedRecent } from "./sort.ts";

export type Level = "error" | "warn" | "info";

export interface Issue {
  level: Level;
  /** Grouping for display. */
  group: "schema" | "content" | "order" | "writing" | "consistency";
  message: string;
  /** Unsorted section that "sort" can fix. */
  unsorted?: SectionKey;
  /** Where the problem is, so a UI can jump to it. */
  target?: { section: SectionKey | "basics"; index?: number };
}

// Openers that describe duties rather than results.
const WEAK_OPENERS = /^(responsible for|helped|assisted|worked on|involved in|tasked with|duties included|participated in)\b/i;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const hasNumber = (s: string) => /\d/.test(s);

export const LIMITS = { highlightWords: 30, roleSummaryWords: 40, summaryWords: 80, highlightsPerRole: 6 };

export function lint(r: Resume): Issue[] {
  const parsed = Resume.safeParse(r);
  if (!parsed.success) return [{ level: "error", group: "schema", message: z.prettifyError(parsed.error) }];

  const issues: Issue[] = [];
  const add = (level: Level, group: Issue["group"], message: string, extra: Partial<Issue> = {}) =>
    issues.push({ level, group, message, ...extra });

  // Content
  const basics = { target: { section: "basics" as const } };
  if (!r.basics.name) add("warn", "content", "basics.name is empty", basics);
  if (!r.basics.email) add("warn", "content", "basics.email is empty", basics);
  if (!r.basics.summary) add("warn", "content", "basics.summary is empty", basics);
  if (!r.skills.length) {
    add("warn", "content", "Skills is empty: ATS keyword matching relies on it. Try \"Suggest skills\"", { target: { section: "skills" } });
  }
  if (!r.education.length) add("info", "content", "Education is empty (fine if deliberate)");
  if (!r.languages.length) add("info", "content", "Languages is empty (fine if deliberate)");

  r.work.forEach((w, i) => {
    const name = `work[${i}] "${w.name}"`;
    const at = { target: { section: "work" as const, index: i } };
    if (!w.startDate) add("warn", "content", `${name} has no startDate`, at);
    if (!w.highlights?.length) add("warn", "content", `${name} has no highlights`, at);
    if (w.startDate && w.endDate && w.endDate < w.startDate) add("error", "content", `${name} ends before it starts`, at);
  });

  // Order
  for (const s of SECTIONS) {
    if (s.dated && !isSortedRecent(r[s.key] as Record<string, any>[])) {
      add("warn", "order", `${s.label} is not in reverse-chronological order`, { unsorted: s.key });
    }
  }

  // Writing
  if (r.basics.summary && words(r.basics.summary) > LIMITS.summaryWords) {
    add("warn", "writing", `Summary is ${words(r.basics.summary)} words; aim for under ${LIMITS.summaryWords}`);
  }
  const seen = new Map<string, string>();
  r.work.forEach((w, i) => {
    const name = w.position ? `${w.position} @ ${w.name}` : w.name;
    const at = { target: { section: "work" as const, index: i } };
    if (w.summary && words(w.summary) > LIMITS.roleSummaryWords) {
      add("info", "writing", `${name}: role summary is ${words(w.summary)} words; aim for under ${LIMITS.roleSummaryWords}`, at);
    }
    const hs = w.highlights ?? [];
    if (hs.length > LIMITS.highlightsPerRole) add("info", "writing", `${name}: ${hs.length} highlights; ${LIMITS.highlightsPerRole} or fewer reads better`, at);
    if (hs.length >= 2 && !hs.some(hasNumber)) add("info", "writing", `${name}: no highlight has a number; quantify an outcome`, at);
    for (const h of hs) {
      const short = h.length > 50 ? `${h.slice(0, 49)}…` : h;
      if (words(h) > LIMITS.highlightWords) add("warn", "writing", `${name}: "${short}" is ${words(h)} words`, at);
      if (WEAK_OPENERS.test(h)) add("warn", "writing", `${name}: "${short}" starts weakly; lead with a verb and result`, at);
      const key = h.toLowerCase().replace(/\W+/g, " ").trim();
      const prev = seen.get(key);
      if (prev) add("warn", "writing", `${name}: duplicate highlight (also under ${prev})`, at);
      else seen.set(key, name);
    }
  });

  for (const c of consistency(r)) {
    add(c.level, "consistency", c.message, c.index !== undefined ? { target: { section: "work", index: c.index } } : {});
  }

  return issues;
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.level === "error");
