import { join } from "node:path";
import { z } from "zod";
import { APPLICATIONS_DIR } from "../applications.ts";
import { JobPosting } from "../job.ts";
import type { Resume } from "../schema.ts";
import { applyVariant, loadVariant } from "../variants.ts";
import { type AI } from "./index.ts";

// Interview prep: likely questions for a tailored job, each mapped to the resume evidence that answers it.

const Prep = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        why: z.string().describe("Which requirement or responsibility in the posting this probes"),
        evidence: z.array(z.string()).describe("Exact highlight texts from the resume that answer it; empty if none"),
        talkingPoints: z.array(z.string()).describe("2-3 short notes on how to answer, from the resume only"),
      }),
    )
    .describe("8-10 questions: technical, behavioural and role-specific"),
});

export interface PrepQuestion {
  question: string;
  why: string;
  evidence: string[];
  talkingPoints: string[];
  /** No real resume evidence: prepare a story for this one. */
  gap: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Every highlight in the (variant) resume, for checking that cited evidence is real. */
function highlightIndex(r: Resume): Map<string, string> {
  const all = [
    ...r.work.flatMap((w) => [...(w.highlights ?? []), w.summary]),
    ...r.projects.flatMap((p) => [...(p.highlights ?? []), p.description]),
    ...r.publications.map((p) => p.name),
  ].filter((s): s is string => !!s);
  return new Map(all.map((h) => [norm(h), h]));
}

/** Match a cited line to a real highlight: exact, or one containing the other. */
function resolve(cited: string, index: Map<string, string>): string | undefined {
  const n = norm(cited);
  if (!n) return undefined;
  if (index.has(n)) return index.get(n);
  for (const [k, v] of index) if (k.length > 20 && (k.includes(n) || n.includes(k))) return v;
  return undefined;
}

export async function interviewPrep(ai: AI, r: Resume, job: JobPosting & { url?: string }, variantName?: string): Promise<PrepQuestion[]> {
  const variant = variantName ? await loadVariant(variantName).catch(() => undefined) : undefined;
  const view = applyVariant(r, variant);
  const highlights = [
    ...view.work.flatMap((w) => (w.highlights ?? []).map((h) => `- [${w.position} @ ${w.name}] ${h}`)),
    ...view.projects.flatMap((p) => (p.highlights ?? []).map((h) => `- [project ${p.name}] ${h}`)),
  ];
  const res = await ai.json({
    schema: Prep,
    system:
      "You prepare candidates for interviews. Predict the questions this employer is most likely to ask, and map each to the candidate's own evidence. Cite resume highlights verbatim. If nothing in the resume answers a question, leave evidence empty: that's a gap the candidate should prepare for. Never invent experience. British English.",
    prompt: [
      `JOB: ${[job.title, job.company].filter(Boolean).join(" at ")}`,
      job.summary && `Summary: ${job.summary}`,
      job.requirements?.length && `Requirements:\n${job.requirements.map((x) => `- ${x}`).join("\n")}`,
      job.responsibilities?.length && `Responsibilities:\n${job.responsibilities.map((x) => `- ${x}`).join("\n")}`,
      `\nCANDIDATE HIGHLIGHTS:\n${highlights.join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const index = highlightIndex(r);
  return res.questions.map((q) => {
    const evidence = [...new Set(q.evidence.map((e) => resolve(e.replace(/^- \[[^\]]*\]\s*/, ""), index)).filter((e): e is string => !!e))];
    return { question: q.question, why: q.why, evidence, talkingPoints: evidence.length ? q.talkingPoints : [], gap: !evidence.length };
  });
}

export function prepMarkdown(job: JobPosting, qs: PrepQuestion[]): string {
  const lines = [`# Interview prep: ${[job.title, job.company].filter(Boolean).join(" at ")}`, ""];
  const gaps = qs.filter((q) => q.gap);
  if (gaps.length) lines.push(`**${gaps.length} question(s) with no evidence in your resume.** Prepare a story for these.`, "");
  qs.forEach((q, i) => {
    lines.push(`## ${i + 1}. ${q.question}${q.gap ? " ⚠ gap" : ""}`, "", `_${q.why}_`, "");
    if (q.evidence.length) lines.push("Evidence:", ...q.evidence.map((e) => `- ${e}`), "");
    if (q.talkingPoints.length) lines.push("Talking points:", ...q.talkingPoints.map((t) => `- ${t}`), "");
  });
  return lines.join("\n");
}

/** Prep for a saved application: reads applications/<slug>/job.json, writes interview-prep.md. */
export async function prepForApplication(ai: AI, r: Resume, slug: string): Promise<{ file: string; questions: PrepQuestion[] }> {
  const jobFile = Bun.file(join(APPLICATIONS_DIR, slug, "job.json"));
  if (!(await jobFile.exists())) throw new Error(`No job.json for ${slug}. Re-run Tailor for this posting first.`);
  const job = JobPosting.extend({ url: z.string().optional() }).parse(await jobFile.json());
  const questions = await interviewPrep(ai, r, job, slug);
  const file = join(APPLICATIONS_DIR, slug, "interview-prep.md");
  await Bun.write(file, prepMarkdown(job, questions) + "\n");
  return { file, questions };
}
