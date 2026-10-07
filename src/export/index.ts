import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer";
import type { Resume } from "../schema.ts";
import { prune } from "../store.ts";
import { applyVariant, tighten, viewToResume, type Variant } from "../variants.ts";
import { checkAts, firstGlance, pdfPages, type AtsReport, type Glance } from "./ats.ts";
import type { ResumeView } from "./blocks.ts";
import { renderHtml } from "./html.ts";
import { renderText } from "./text.ts";
import { renderLinkedIn } from "../linkedin.ts";
import { THEMES, themeById, type Theme } from "./themes.ts";

export type Format = "pdf" | "html" | "json" | "text" | "linkedin";
export type PaperSize = "A4" | "Letter";

export const OUT_DIR = process.env.RESUME_OUT_DIR ?? "dist";

/** Lazily launched headless Chrome, shared across PDFs in one run. */
export class PdfRenderer {
  private browser?: Promise<Browser>;

  async render(view: ResumeView, theme: Theme, paper: PaperSize, accent?: string): Promise<Uint8Array> {
    // CI runners (GitHub Actions) don't allow Chrome's sandbox.
    this.browser ??= puppeteer.launch({ args: process.env.CI ? ["--no-sandbox"] : [] });
    const page = await (await this.browser).newPage();
    try {
      await page.setContent(renderHtml(view, { theme, accent }), { waitUntil: "load" });
      return await page.pdf({ format: paper, printBackground: true, preferCSSPageSize: true });
    } finally {
      await page.close();
    }
  }

  async close() {
    if (this.browser) await (await this.browser).close();
    this.browser = undefined;
  }
}

export interface ExportRequest {
  resume: Resume;
  variant?: Variant;
  /** Used in filenames, e.g. ada-example-devrel.pdf */
  variantName?: string;
  formats: Format[];
  themes?: Theme[];
  accent?: string;
  paper?: PaperSize;
  /** Override the variant's targetPages / fit. */
  targetPages?: number;
  fit?: boolean;
  ats?: boolean;
}

export interface PdfResult {
  file: string;
  theme: string;
  pages: number;
  /** Tightening steps applied to fit targetPages. */
  fitted: string[];
  overTarget: boolean;
  ats?: AtsReport;
  /** What the top third of page 1 shows (with the ATS check). */
  glance?: Glance;
}

export interface ExportResult {
  files: string[];
  pdfs: PdfResult[];
}

export async function exportResume(req: ExportRequest, renderer = new PdfRenderer()): Promise<ExportResult> {
  const v = req.variant ?? {};
  const themes = req.themes?.length ? req.themes : [themeById(v.theme) ?? THEMES[0]!];
  const paper = req.paper ?? v.paper ?? "A4";
  const accent = req.accent ?? v.accent;
  const target = req.targetPages ?? v.targetPages;
  const fit = (req.fit ?? v.fit ?? false) && !!target;

  const base = [slug(req.resume.basics.name ?? "resume"), req.variantName && slug(req.variantName)].filter(Boolean).join("-");
  const files: string[] = [];
  const pdfs: PdfResult[] = [];
  let view = applyVariant(req.resume, v);

  if (req.formats.includes("pdf")) {
    for (const theme of themes) {
      let themed = applyVariant(req.resume, v);
      let pdf = await renderer.render(themed, theme, paper, accent);
      let pages = await pdfPages(pdf);
      const fitted: string[] = [];

      if (fit && pages > target!) {
        for (const { variant, step } of tighten(v, req.resume)) {
          themed = applyVariant(req.resume, variant);
          pdf = await renderer.render(themed, theme, paper, accent);
          pages = await pdfPages(pdf);
          fitted.push(step);
          if (pages <= target!) break;
        }
      }

      const file = join(OUT_DIR, themes.length > 1 ? `${base}-${theme.id}.pdf` : `${base}.pdf`);
      await Bun.write(file, pdf);
      files.push(file);
      pdfs.push({
        file, theme: theme.id, pages, fitted,
        overTarget: !!target && pages > target,
        ats: req.ats ? await checkAts(pdf, themed) : undefined,
        glance: req.ats ? await firstGlance(pdf, themed) : undefined,
      });
      // Other formats follow the content of the first (fitted) theme so they match the PDF.
      if (theme === themes[0]) view = themed;
    }
  }

  if (req.formats.includes("html")) {
    const file = join(OUT_DIR, `${base}.html`);
    await Bun.write(file, renderHtml(view, { theme: themes[0], accent }));
    files.push(file);
  }
  if (req.formats.includes("json")) {
    const file = join(OUT_DIR, `${base}.json`);
    const r = viewToResume(view);
    const { pdf, sources, ...meta } = r.meta ?? {}; // tool settings stay out of the shareable export
    await Bun.write(file, JSON.stringify(prune({ ...r, meta }), null, 2) + "\n");
    files.push(file);
  }
  if (req.formats.includes("linkedin")) {
    const file = join(OUT_DIR, `${base}-linkedin.md`);
    await Bun.write(file, renderLinkedIn(view) + "\n");
    files.push(file);
  }
  if (req.formats.includes("text")) {
    const file = join(OUT_DIR, `${base}.txt`);
    await Bun.write(file, renderText(view));
    files.push(file);
  }
  return { files, pdfs };
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "resume";
