import type { PdfResult } from "./index.ts";

/** Human-readable lines for one exported PDF: pages, fitting, ATS check, first glance. */
export function describePdf(p: PdfResult): string[] {
  const lines = [`${p.file}: ${p.pages} page${p.pages === 1 ? "" : "s"}${p.overTarget ? " (over target)" : ""}`];
  if (p.fitted.length) lines.push(`  fitted by: ${p.fitted.join(", ")}`);
  if (p.ats) {
    const a = p.ats;
    lines.push(`  ATS: ${a.ok ? "✔ pass" : "✖ fail"}, ${Math.round(a.wordCoverage * 100)}% of words extracted`);
    if (a.missing.length) lines.push(`    missing: ${a.missing.join(" | ")}`);
    if (a.outOfOrder.length) lines.push(`    out of order: ${a.outOfOrder.join(" | ")}`);
  }
  if (p.glance) {
    lines.push(`  First glance: ${p.glance.shows.join(", ") || "nothing recognisable"}`);
    p.glance.warnings.forEach((w) => lines.push(`    ▲ ${w}`));
  }
  return lines;
}
