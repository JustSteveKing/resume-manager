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

// ---------- where PDFs are printed ----------

/**
 * Local headless Chrome (default), or Ichabod, Mozilla's cloud browser. Ichabod is opt-in: the resume
 * HTML (contact details included) is sent to it, and its sessions can be recorded.
 */
export type PdfBrowser = "local" | "ichabod";
export const pdfBrowser = (): PdfBrowser => (process.env.RESUME_PDF_BROWSER === "ichabod" ? "ichabod" : "local");

export const ICHABOD_HOST = "stage.api.ichabod.nonprod.webservices.mozgcp.net";
export const ICHABOD_PRIVACY = "Exports will send your resume (contact details included) to Ichabod, Mozilla's cloud browser; its sessions can be recorded. The TUI page preview stays local.";
/**
 * Engine and default version. Gecko (Firefox) by default. It lays pages out a little differently from
 * local Chrome, so page counts can differ; each export's fit and ATS check run on the PDF it produced.
 * Chromium matches local Chrome.
 */
export type IchabodEngine = "chromium" | "gecko";
export const ICHABOD_VERSIONS: Record<IchabodEngine, string> = { chromium: "154", gecko: "157" };
export const ichabodEngine = (): IchabodEngine => (process.env.ICHABOD_ENGINE?.trim() === "chromium" ? "chromium" : "gecko");

/** WebDriver BiDi endpoint: wss://<host>/{engine}/{version}. A bare host gets wss://; an explicit ws(s):// is kept. */
export function ichabodEndpoint(
  host = process.env.ICHABOD_HOST?.trim() || ICHABOD_HOST,
  engine: IchabodEngine = ichabodEngine(),
  version = process.env.ICHABOD_VERSION?.trim() || ICHABOD_VERSIONS[engine],
): string {
  const base = (/^wss?:\/\//.test(host) ? host : `wss://${host.replace(/^https?:\/\//, "")}`).replace(/\/+$/, "");
  return `${base}/${engine}/${version}`;
}

/**
 * Open an Ichabod session with Puppeteer over WebDriver BiDi. Ichabod's examples put the key in the URL
 * (api:<key>@host), but Bun's WebSocket doesn't turn URL credentials into a header, so the same Basic
 * auth goes in an explicit header (which also keeps the key out of error messages).
 * browser.close() ends the session; disconnecting would leak it.
 */
export interface IchabodOptions {
  key?: string;
  /** Give up on one attempt after this long (default 20s). */
  attemptMs?: number;
  /** Attempts before failing (default 2). */
  attempts?: number;
  /** Progress for the UI: "Waiting for an Ichabod browser", retries. */
  status?: (message: string) => void;
  /** How to connect; tests pass a fake. */
  connect?: (options: Parameters<typeof puppeteer.connect>[0]) => Promise<Browser>;
}

/**
 * Ichabod sometimes takes minutes to hand out a browser, and an immediate retry is usually quick. So each
 * attempt gets `attemptMs`, a session that arrives after we gave up is closed (not left running on
 * Ichabod), and every later command is capped at a minute instead of Puppeteer's three.
 */
export async function connectIchabod(opts: IchabodOptions = {}): Promise<Browser> {
  const key = opts.key ?? process.env.ICHABOD_API_KEY?.trim();
  if (!key) {
    throw new Error("PDF browser is Ichabod but no Ichabod key is set. Add it in Settings or with `cv config key ichabod <key>`, or switch back: `cv config pdf-browser local`.");
  }
  const { attemptMs = 20_000, attempts = 2, status, connect = (o) => puppeteer.connect(o) } = opts;
  const endpoint = ichabodEndpoint();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    status?.(attempt === 1 ? "Waiting for an Ichabod browser" : `Ichabod is busy; trying again (${attempt}/${attempts})`);
    const pending = connect({ browserWSEndpoint: endpoint, protocol: "webDriverBiDi", protocolTimeout: 60_000, headers: { Authorization: `Basic ${btoa(`api:${key}`)}` } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then((browser) => ({ browser }), (error: unknown) => ({ error })),
      new Promise<{ timedOut: true }>((resolve) => (timer = setTimeout(() => resolve({ timedOut: true }), attemptMs))),
    ]);
    clearTimeout(timer);
    if ("browser" in outcome) return outcome.browser;
    if ("error" in outcome) {
      // Refused, unauthorised, bad host: retrying won't help.
      const e = outcome.error;
      throw new Error(`Couldn't connect to Ichabod at ${endpoint}: ${e instanceof Error ? e.message : e}`);
    }
    pending.then((browser) => browser.close(), () => {});
  }
  throw new Error(`Ichabod didn't provide a browser within ${attemptMs / 1000}s (${attempts} tries); it may be busy. Try again, or switch PDF browser to local in Settings.`);
}

/** A browser shared across PDFs in one run, opened on first use. */
export class PdfRenderer {
  private browser?: Promise<Browser>;

  /**
   * `browser` overrides the configured choice (the TUI page preview always prints locally: it re-renders
   * on every edit). `open` replaces how the browser is obtained, for tests.
   */
  constructor(private opts: { browser?: PdfBrowser; open?: () => Promise<Browser>; status?: (message: string) => void } = {}) {}

  /** Where this renderer prints. */
  get where(): PdfBrowser {
    return this.opts.browser ?? pdfBrowser();
  }

  private open(): Promise<Browser> {
    if (this.opts.open) return this.opts.open();
    if (this.where === "ichabod") return connectIchabod({ status: this.opts.status });
    // CI runners (GitHub Actions) don't allow Chrome's sandbox.
    return puppeteer.launch({ args: process.env.CI ? ["--no-sandbox"] : [] });
  }

  async render(view: ResumeView, theme: Theme, paper: PaperSize, accent?: string): Promise<Uint8Array> {
    // A failed open isn't cached: the next render tries again.
    this.browser ??= this.open().catch((e) => {
      this.browser = undefined;
      throw e;
    });
    const page = await (await this.browser).newPage();
    try {
      await page.setContent(renderHtml(view, { theme, accent }), { waitUntil: "load" });
      return await page.pdf({ format: paper, printBackground: true, preferCSSPageSize: true });
    } finally {
      await page.close();
    }
  }

  async close() {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await (await browser.catch(() => undefined))?.close();
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
  /** Progress while a browser is being obtained (used when exportResume opens its own renderer). */
  progress?: (message: string) => void;
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

/** Without a renderer, one is opened for this export and closed after it (a cloud session, or a local Chrome). */
export async function exportResume(req: ExportRequest, renderer?: PdfRenderer): Promise<ExportResult> {
  if (!renderer) {
    const own = new PdfRenderer({ status: req.progress });
    try {
      return await exportResume(req, own);
    } finally {
      await own.close();
    }
  }
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
