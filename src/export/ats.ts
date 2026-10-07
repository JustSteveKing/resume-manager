import { extractText, getDocumentProxy } from "unpdf";
import { formatRange } from "../dates.ts";
import { BLOCK_IDS, type BlockId, type ResumeView } from "./blocks.ts";
import { renderText } from "./text.ts";

export interface AtsReport {
  pages: number;
  /** Share of words from the plain-text export that survive PDF text extraction. */
  wordCoverage: number;
  /** Expected strings an ATS could not find. */
  missing: string[];
  /** Roles that extract in a different order to the resume. */
  outOfOrder: string[];
  ok: boolean;
}

// Normalise ligatures (NFKC turns "ﬁ" into "fi"), dashes, quotes and whitespace.
const norm = (s: string) =>
  s.normalize("NFKC").replace(/[‐-―]/g, "-").replace(/[‘’]/g, "'").replace(/\s+/g, " ").toLowerCase().trim();

export async function pdfPages(pdf: Uint8Array): Promise<number> {
  return (await getDocumentProxy(pdf.slice())).numPages;
}

export async function pdfText(pdf: Uint8Array): Promise<{ text: string; pages: number }> {
  const doc = await getDocumentProxy(pdf.slice());
  const { text } = await extractText(doc, { mergePages: true });
  return { text, pages: doc.numPages };
}

/** [data key, block that renders it, heading text] */
const HEADINGS: [keyof ResumeView | "earlierCareer", BlockId, string][] = [
  ["work", "experience", "Experience"], ["earlierCareer", "earlier", "Earlier Career"], ["projects", "projects", "Projects"],
  ["skills", "skills", "Skills"], ["publications", "publications", "Publications & Talks"], ["education", "education", "Education"],
  ["volunteer", "volunteer", "Volunteering"], ["languages", "languages", "Languages"],
];

/** Check that what an ATS extracts from the PDF still contains the resume's key facts, in order. */
export async function checkAts(pdf: Uint8Array, view: ResumeView): Promise<AtsReport> {
  const { text, pages } = await pdfText(pdf);
  const got = norm(text);
  const b = view.basics;

  // Headings must extract as a whole line: "developer experience" in a sentence is not the Experience heading.
  const lines = new Set(text.split("\n").map((l) => norm(l).replace(/^[#>•*\-\s]+/, "")));
  // Only sections the variant actually shows (blockOrder) can be expected in the PDF.
  const shown = new Set<BlockId>(view.blockOrder ?? BLOCK_IDS);
  const headings = HEADINGS.filter(([key, block]) => {
    const items = view[key as keyof ResumeView];
    return shown.has(block) && Array.isArray(items) && items.length;
  }).map(([, , h]) => h);
  if (b.summary && shown.has("summary")) headings.unshift("Summary");
  const missingHeadings = headings.filter((h) => !lines.has(norm(h)));

  const expected = [b.name, b.email, b.phone].filter(Boolean) as string[];
  for (const w of view.work) {
    expected.push(w.name);
    if (w.position) expected.push(w.position);
    const when = formatRange(w.startDate, w.endDate);
    if (when) expected.push(when);
  }
  const missing = [...missingHeadings.map((h) => `heading "${h}"`), ...[...new Set(expected)].filter((s) => !got.includes(norm(s)))];

  // Roles should appear in the same order they're listed.
  const outOfOrder: string[] = [];
  let cursor = 0;
  for (const w of view.work) {
    const label = norm(w.position ? `${w.position}` : w.name);
    const at = got.indexOf(label, cursor);
    if (at === -1) {
      if (got.includes(label)) outOfOrder.push(w.position ?? w.name);
      continue;
    }
    cursor = at + label.length;
  }

  const words = (s: string) => norm(s).split(/[^a-z0-9@.+#]+/).filter((w) => w.length > 2);
  const have = new Set(words(text));
  // URLs print in the text export but are link labels in the PDF; "Technologies:" is a text-only label.
  const want = words(renderText(view).replace(/https?:\/\/\S+/g, "").replace(/^\s*Technologies:/gm, ""));
  const wordCoverage = want.length ? want.filter((w) => have.has(w)).length / want.length : 1;

  return { pages, wordCoverage, missing, outOfOrder, ok: !missing.length && !outOfOrder.length && wordCoverage > 0.95 };
}

// ---------- first glance ----------

export interface Glance {
  /** What the top third of page 1 shows, in reading order. */
  shows: string[];
  /** The first role a recruiter sees, if any. */
  firstRole?: string;
  warnings: string[];
}

/**
 * The top third of page 1 is what a recruiter reads in the first few seconds.
 * Report what lands there and flag layouts where experience doesn't make it.
 */
export async function firstGlance(pdf: Uint8Array, view: ResumeView): Promise<Glance> {
  const doc = await getDocumentProxy(pdf.slice());
  const { text } = await extractText(doc, { mergePages: false });
  const page1 = (Array.isArray(text) ? text[0] : text) ?? "";
  const lines = page1.split("\n").map((l) => l.trim()).filter(Boolean);
  const top = lines.slice(0, Math.max(6, Math.ceil(lines.length / 3)));
  const topText = norm(top.join(" "));
  const b = view.basics;
  const shows: string[] = [];
  const warnings: string[] = [];

  if (b.name && topText.includes(norm(b.name))) shows.push("name");
  if (b.label && topText.includes(norm(b.label).slice(0, 30))) shows.push("headline");
  if ((b.email && topText.includes(norm(b.email))) || (b.phone && topText.includes(norm(b.phone)))) shows.push("contact");
  const summaryWords = b.summary?.trim().split(/\s+/).length ?? 0;
  if (b.summary && topText.includes(norm(b.summary).slice(0, 40))) shows.push(`summary (${summaryWords} words)`);
  const firstRole = view.work.find((w) => (w.position && topText.includes(norm(w.position))) || topText.includes(norm(w.name)));
  if (firstRole) shows.push(`first role: ${[firstRole.position, firstRole.name].filter(Boolean).join(" @ ")}`);

  if (!shows.includes("name")) warnings.push("Your name isn't in the top third of page 1");
  if (!firstRole && view.work.length) warnings.push("No experience in the top third: the header and summary take all the space. Shorten the summary or use a denser theme");
  if (summaryWords > 60) warnings.push(`Summary is ${summaryWords} words; at a glance, 2 lines read better than 5`);
  return { shows, firstRole: firstRole ? [firstRole.position, firstRole.name].filter(Boolean).join(" @ ") : undefined, warnings };
}
