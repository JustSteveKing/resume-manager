import { z } from "zod";
import { isGrounded } from "../grounding.ts";
import type { Resume, Work } from "../schema.ts";
import { WRITING_RULES, type AI } from "./index.ts";

// Writing coach (rewrite one bullet or summary) and achievement interviewer
// (ask about a role, turn the answers into quantified bullets).

export type TextKind = "highlight" | "summary" | "role-summary";

type Style = "shorter" | "result" | "xyz";

/** Style briefs per kind: a profile summary isn't a bullet, so it gets profile-shaped styles. */
const STYLES: Record<"bullet" | "profile", Record<Style, string>> = {
  bullet: {
    shorter: "Shorter: same facts, half the words",
    result: "Result first: open with the outcome, then how",
    xyz: "Did X, measured by Y, by doing Z. If the text has no measure, name the concrete change instead; never pad one in",
  },
  profile: {
    shorter: "Shorter: same facts, about half the words",
    result: "Lead with the strongest credential: open with what most sets this person apart",
    xyz: "Focused: what they do, for whom, and the proof, in two sentences",
  },
};

const PROFILE_RULES = `- This is a profile summary: start with who the person is (e.g. "Developer educator and API mentor…"), never with an imperative verb ("Lead…", "Shape…"). No "I".`;

const Rewrites = z.object({
  options: z
    .array(z.object({ style: z.enum(["shorter", "result", "xyz"]), text: z.string() }))
    .describe("One rewrite per style: shorter, result, xyz"),
});

export interface Rewrite {
  style: Style;
  label: string;
  text: string;
}

const roleContext = (w?: Work) =>
  w ? `Role: ${[w.position, w.name].filter(Boolean).join(" at ")} (${w.startDate ?? "?"} to ${w.endDate ?? "present"})` : "";

/** 2-3 rewrites of one piece of text. Any rewrite that introduces a number not in the original is dropped. */
export async function rewrite(ai: AI, text: string, kind: TextKind, role?: Work): Promise<Rewrite[]> {
  const limit = kind === "highlight" ? "under 25 words" : kind === "role-summary" ? "under 35 words" : "2-3 sentences, under 60 words";
  const styles = STYLES[kind === "summary" ? "profile" : "bullet"];
  const res = await ai.json({
    schema: Rewrites,
    system: `You are an expert resume editor. Rewrite the text in three styles.\n${WRITING_RULES}\n- Each rewrite: ${limit}, one ${kind === "highlight" ? "bullet, no leading symbol" : "paragraph"}.${kind === "summary" ? `\n${PROFILE_RULES}` : ""}`,
    prompt: `${roleContext(role)}\nText (${kind}):\n${text}\n\nStyles:\n${Object.entries(styles).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
  });
  const facts = `${text}\n${roleContext(role)}`;
  const seen = new Set<string>();
  return res.options
    .filter((o) => o.text.trim() && o.text.trim() !== text.trim() && isGrounded(o.text, facts))
    .filter((o) => !seen.has(o.style) && seen.add(o.style))
    .map((o) => ({ style: o.style, label: styles[o.style].split(".")[0]!, text: o.text.trim().replace(/^[-•*]\s*/, "") }));
}

// ---------- interviewer ----------

export interface Question {
  question: string;
  /** What a good answer unlocks, shown to the user. */
  why: string;
}

const Questions = z.object({
  questions: z.array(z.object({ question: z.string(), why: z.string() })).describe("2-3 short questions"),
});

/** Questions that would unlock a missing number or outcome; template fallback when there's no AI. */
export function templateQuestions(w: Work): Question[] {
  const first = w.highlights?.[0] ?? w.summary ?? "this role";
  const short = first.length > 70 ? `${first.slice(0, 67)}…` : first;
  return [
    { question: `For "${short}": what changed because of it, in numbers? (users, revenue, time, errors, cost)`, why: "Turns a duty into a measurable result" },
    { question: `How big was the scope at ${w.name}? (team size, users, traffic, budget, number of services)`, why: "Gives the reader a sense of scale" },
    { question: `What are you proudest of from ${w.position ?? "this role"} that isn't on your resume yet?`, why: "Surfaces achievements you forgot to list" },
  ];
}

export async function interviewQuestions(ai: AI | undefined, w: Work): Promise<Question[]> {
  if (!ai) return templateQuestions(w);
  const res = await ai.json({
    schema: Questions,
    system:
      "You interview people to strengthen their resume. Ask 2-3 short, specific questions whose answers would add numbers, scope or outcomes this role is missing. Never ask about anything already stated. British English.",
    prompt: roleFacts(w),
  });
  return res.questions.length ? res.questions.slice(0, 3) : templateQuestions(w);
}

const Bullets = z.object({ bullets: z.array(z.string()).describe("2-4 resume bullets") });

export function roleFacts(w: Work): string {
  return [
    `Role: ${w.position ?? "?"} at ${w.name} (${w.startDate ?? "?"} to ${w.endDate ?? "present"})`,
    w.summary && `Summary: ${w.summary}`,
    ...(w.highlights ?? []).map((h) => `Highlight: ${h}`),
  ]
    .filter(Boolean)
    .join("\n");
}

export interface Drafted {
  bullets: string[];
  /** Drafts dropped because they used numbers neither the role nor the answers contain. */
  dropped: string[];
}

/** Turn interview answers into bullets. The answers are facts, so numbers from them are allowed. */
export async function draftBullets(ai: AI, w: Work, answers: { question: string; answer: string }[]): Promise<Drafted> {
  const qa = answers.filter((a) => a.answer.trim()).map((a) => `Q: ${a.question}\nA: ${a.answer.trim()}`).join("\n\n");
  if (!qa) return { bullets: [], dropped: [] };
  const res = await ai.json({
    schema: Bullets,
    system: `Write resume bullets from a candidate's interview answers.\n${WRITING_RULES}\n- Each bullet under 25 words, outcome first where possible, no leading symbol.\n- Don't repeat existing highlights.`,
    prompt: `${roleFacts(w)}\n\nInterview:\n${qa}`,
  });
  const facts = `${roleFacts(w)}\n${qa}`;
  const existing = new Set((w.highlights ?? []).map((h) => h.toLowerCase()));
  const bullets: string[] = [];
  const dropped: string[] = [];
  for (const raw of res.bullets) {
    const b = raw.trim().replace(/^[-•*]\s*/, "");
    if (!b || existing.has(b.toLowerCase())) continue;
    (isGrounded(b, facts) ? bullets : dropped).push(b);
  }
  return { bullets, dropped };
}

/** Roles that most need the interviewer: no numbers anywhere, few highlights, or long summaries. */
export function rolesNeedingWork(r: Resume): { index: number; reasons: string[] }[] {
  return r.work
    .map((w, index) => {
      const reasons: string[] = [];
      const hs = w.highlights ?? [];
      if (!hs.length) reasons.push("no highlights");
      else if (!hs.some((h) => /\d/.test(h))) reasons.push("no numbers");
      if (hs.length === 1) reasons.push("only one highlight");
      if ((w.summary?.trim().split(/\s+/).length ?? 0) > 40) reasons.push("long summary");
      return { index, reasons };
    })
    .filter((x) => x.reasons.length);
}
