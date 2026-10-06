import { z } from "zod";
import { renderText } from "./export/text.ts";
import { coverage } from "./keywords.ts";
import type { Resume } from "./schema.ts";
import { extractObject, tabstack, toTabstackSchema, type Effort } from "./tabstack.ts";
import { applyVariant, type Variant } from "./variants.ts";

export const JobPosting = z.object({
  title: z.string().optional().describe("Job title"),
  company: z.string().optional().describe("Hiring company name"),
  companyUrl: z.string().optional().describe("Company website URL"),
  location: z.string().optional().describe("Location, including remote/hybrid if stated"),
  seniority: z.string().optional().describe("e.g. Senior, Staff, Lead, Manager"),
  summary: z.string().optional().describe("Two sentence summary of the role"),
  responsibilities: z.array(z.string()).optional().describe("What the person will do"),
  requirements: z.array(z.string()).optional().describe("Must-have requirements"),
  niceToHave: z.array(z.string()).optional().describe("Nice-to-have / bonus requirements"),
  keywords: z
    .array(z.string())
    .optional()
    .describe(
      "Technologies, tools, skills and domain terms an applicant tracking system would match on, in short canonical form (e.g. 'Laravel', 'API design', 'Kubernetes', 'Technical writing'). 10-30 items.",
    ),
});

export type JobPosting = z.infer<typeof JobPosting>;

export const extractJob = (url: string, effort: Effort = "standard") =>
  extractObject(url, JobPosting, effort) as Promise<JobPosting>;

export function jobCoverage(r: Resume, job: JobPosting) {
  return coverage(r, job.keywords ?? []);
}

/** A variant ranked against the posting's keywords, built on top of an optional base variant. */
export function tailorVariant(job: JobPosting, url: string, base: Variant = {}): Variant {
  return {
    targetPages: 2,
    fit: true,
    dropRoleSummaries: true,
    maxHighlights: 4,
    maxPublications: 6,
    ...base,
    label: [job.title, job.company].filter(Boolean).join(" @ ") || "Tailored",
    description: `Tailored to ${url}`,
    keywords: [...new Set([...(base.keywords ?? []), ...(job.keywords ?? [])])],
    job: { url, title: job.title, company: job.company },
  };
}

export const Tailored = z.object({
  headline: z.string().describe("Professional title for the resume header, matched to the role, under 10 words"),
  summary: z.string().describe("Resume summary tailored to the role, 2-3 sentences, under 70 words, first person implied (no 'I')"),
  coverLetter: z
    .string()
    .describe("Cover letter, 3-4 short paragraphs, plain text with blank lines between paragraphs, no placeholders"),
});

export type Tailored = z.infer<typeof Tailored>;

const MAX_INSTRUCTIONS = 20_000;

/**
 * Write a tailored headline, summary and cover letter. Tabstack fetches the job posting at `url`;
 * the candidate's resume travels in the instructions.
 */
export async function generateTailored(url: string, r: Resume, variant: Variant, job: JobPosting): Promise<Tailored> {
  const preamble = `The page is a job posting${job.title ? ` for "${job.title}"` : ""}${job.company ? ` at ${job.company}` : ""}.
Using ONLY facts from the candidate resume below, write a tailored resume headline, summary and cover letter for this role.
Never invent employers, numbers, dates or skills. Mirror the posting's language where the resume genuinely supports it.
Tone: direct, confident, specific, no clichés ("passionate", "rockstar", "synergy"). British English.

CANDIDATE RESUME:
`;
  const resumeText = renderText(applyVariant(r, variant)).slice(0, MAX_INSTRUCTIONS - preamble.length - 100);
  const res = await tabstack().generate.json({
    url,
    instructions: preamble + resumeText,
    json_schema: toTabstackSchema(Tailored),
  });
  return Tailored.parse(res);
}

/** Tabstack Research on the company. Costs real money (~$2 per fast run), so callers must confirm first. */
export async function researchCompany(
  job: JobPosting,
  onProgress?: (message: string) => void,
): Promise<{ report: string; sources: string[] }> {
  const who = [job.company, job.companyUrl && `(${job.companyUrl})`].filter(Boolean).join(" ");
  const stream = await tabstack().agent.research({
    mode: "fast",
    query: `Brief a job candidate applying for "${job.title ?? "a role"}" at ${who}. Cover: what the company does and sells, size and stage, recent news (last 12 months), engineering culture and tech stack, and 3 informed questions to ask in interview. Be concise and cite sources.`,
  });
  for await (const event of stream) {
    if (event.event === "complete") {
      const cited = (event.data.metadata as { citedPages?: { url?: string }[] }).citedPages ?? [];
      return { report: event.data.report, sources: cited.map((p) => p.url).filter(Boolean) as string[] };
    }
    if (event.event === "error") throw new Error(`Research failed: ${event.data.message}`);
    const message = (event.data as { message?: string }).message;
    if (message) onProgress?.(message);
  }
  throw new Error("Research ended without a report");
}

export function jobReport(job: JobPosting, cov: ReturnType<typeof jobCoverage>, url: string): string {
  const list = (title: string, items?: string[]) => (items?.length ? [`## ${title}`, ...items.map((i) => `- ${i}`), ""] : []);
  return [
    `# ${[job.title, job.company].filter(Boolean).join(" @ ") || "Job posting"}`,
    "",
    `Source: ${url}`,
    job.location && `Location: ${job.location}`,
    "",
    job.summary ?? "",
    "",
    `## Keyword coverage: ${Math.round(cov.ratio * 100)}%`,
    `Covered: ${cov.covered.join(", ") || "none"}`,
    `Missing: ${cov.missing.join(", ") || "none"}`,
    "",
    ...list("Requirements", job.requirements),
    ...list("Nice to have", job.niceToHave),
    ...list("Responsibilities", job.responsibilities),
  ]
    .filter((l): l is string => typeof l === "string")
    .join("\n");
}

export const APPLICATIONS_DIR = process.env.RESUME_APPLICATIONS_DIR ?? "applications";

/** Write job.md, cover-letter.md and research.md for an application. Returns written paths. */
export async function saveApplication(
  slug: string,
  parts: { url: string; job: JobPosting; cov: ReturnType<typeof jobCoverage>; tailored?: Tailored; research?: { report: string; sources: string[] } },
): Promise<string[]> {
  const dir = `${APPLICATIONS_DIR}/${slug}`;
  const files: [string, string][] = [[`${dir}/job.md`, jobReport(parts.job, parts.cov, parts.url) + "\n"]];
  if (parts.tailored) {
    files.push([`${dir}/cover-letter.md`, parts.tailored.coverLetter.trim() + "\n"]);
  }
  if (parts.research) {
    const sources = parts.research.sources.map((s) => `- ${s}`).join("\n");
    files.push([`${dir}/research.md`, `${parts.research.report.trim()}\n${sources ? `\n## Sources\n${sources}\n` : ""}`]);
  }
  for (const [path, body] of files) await Bun.write(path, body);
  return files.map(([path]) => path);
}
