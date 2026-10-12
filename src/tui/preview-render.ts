import * as napi from "@napi-rs/canvas";
import { getDocumentProxy } from "unpdf";
import { pdfPages } from "../export/ats.ts";
import type { ResumeView } from "../export/blocks.ts";
import { PdfRenderer, type PaperSize } from "../export/index.ts";
import type { Theme } from "../export/themes.ts";

// In-terminal PDF preview: a Chrome kept warm for the session renders the real PDF, and pages are
// rasterised to PNG on demand (and cached) for OpenTUI's image renderable.

let renderer: PdfRenderer | undefined;
const pdfCache = new Map<string, Promise<{ pdf: Uint8Array; pages: number }>>();
const pngCache = new Map<string, Promise<Uint8Array>>();

export async function closePreviewRenderer() {
  await renderer?.close();
  renderer = undefined;
}

/** Render (or reuse) the PDF for a view and look. Keyed by content, so unchanged resumes don't re-render. */
export function renderPreviewPdf(view: ResumeView, theme: Theme, paper: PaperSize, accent?: string) {
  const key = Bun.hash(JSON.stringify([view, theme.id, paper, accent])).toString(16);
  let hit = pdfCache.get(key);
  if (!hit) {
    renderer ??= new PdfRenderer({ browser: "local" }); // re-renders on every edit: never a cloud session
    hit = renderer.render(view, theme, paper, accent).then(async (pdf) => ({ pdf, pages: await pdfPages(pdf) }));
    pdfCache.set(key, hit);
    hit.catch(() => pdfCache.delete(key));
    // Keep memory bounded: only recent looks matter while editing.
    if (pdfCache.size > 12) pdfCache.delete(pdfCache.keys().next().value!);
  }
  return hit;
}

/** PNG of one page (1-based), width in pixels. */
export function pagePng(pdf: Uint8Array, page: number, width = 1100): Promise<Uint8Array> {
  const key = `${Bun.hash(pdf).toString(16)}:${page}:${width}`;
  let hit = pngCache.get(key);
  if (!hit) {
    hit = rasterise(pdf, page, width);
    pngCache.set(key, hit);
    hit.catch(() => pngCache.delete(key));
    if (pngCache.size > 40) pngCache.delete(pngCache.keys().next().value!);
  }
  return hit;
}

/**
 * Rasterise one page with PDF.js onto @napi-rs/canvas.
 *
 * OpenTUI defines a global `window` (a requestAnimationFrame shim that only fires while the
 * renderer is drawing). With `window` present PDF.js takes its browser path: it schedules render
 * steps with requestAnimationFrame and expects browser globals. So we render with intent "print"
 * (synchronous, no requestAnimationFrame) and supply Path2D/ImageData/DOMMatrix from the canvas
 * library. unpdf's renderPageAsImage can't pass the intent, which is why this isn't using it.
 */
async function rasterise(pdf: Uint8Array, pageNumber: number, width: number): Promise<Uint8Array> {
  const g = globalThis as Record<string, unknown>;
  for (const k of ["Path2D", "ImageData", "DOMMatrix"] as const) g[k] ??= (napi as unknown as Record<string, unknown>)[k];
  const doc = await getDocumentProxy(pdf.slice());
  {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = napi.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport, intent: "print" }).promise;
    return new Uint8Array(await canvas.encode("png"));
  }
}
