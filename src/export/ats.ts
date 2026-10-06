import { extractText, getDocumentProxy } from "unpdf";
import { formatRange } from "../dates.ts";
import type { ResumeView } from "./blocks.ts";
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

const HEADINGS: [keyof ResumeView | "earlierCareer", string][] = [
  ["work", "Experience"], ["earlierCareer", "Earlier Career"], ["projects", "Projects"], ["skills", "Skills"],
  ["publications", "Publications & Talks"], ["education", "Education"], ["volunteer", "Volunteering"],
  ["languages", "Languages"],
];

/** Check that what an ATS extracts from the PDF still contains the resume's key facts, in order. */
export async function checkAts(pdf: Uint8Array, view: ResumeView): Promise<AtsReport> {
  const { text, pages } = await pdfText(pdf);
  const got = norm(text);
  const b = view.basics;

  // Headings must extract as a whole line: "developer experience" in a sentence is not the Experience heading.
  const lines = new Set(text.split("\n").map((l) => norm(l).replace(/^[#>•*\-\s]+/, "")));
  const headings = HEADINGS.filter(([key]) => {
    const items = view[key as keyof ResumeView];
    return Array.isArray(items) && items.length;
  }).map(([, h]) => h);
  if (b.summary) headings.unshift("Summary");
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
