import type { BlockId } from "./blocks.ts";

export interface Theme {
  id: string;
  label: string;
  description: string;
  /** Default accent colour, exposed to CSS as var(--accent). */
  accent: string;
  /** Blocks moved into a left-hand column. Omit for a single column. */
  sidebar?: BlockId[];
  css: string;
}

// System font stacks only: no network fetches during PDF rendering.
const SANS = `"Helvetica Neue", Helvetica, Arial, sans-serif`;
const SERIF = `Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif`;
const MONO = `"SF Mono", Menlo, Consolas, "Liberation Mono", monospace`;

const classic: Theme = {
  id: "classic",
  label: "Classic",
  description: "Clean sans-serif, accent section rules",
  accent: "#2b5797",
  css: `
    @page { margin: 14mm 16mm; }
    body { font: 10pt/1.45 ${SANS}; }
    h1 { font-size: 22pt; letter-spacing: -0.02em; }
    .label { font-size: 11.5pt; color: #555; margin-top: 2px; }
    .contacts { font-size: 9pt; color: #444; margin-top: 6px; }
    section { margin-top: 14px; }
    h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent);
         border-bottom: 1px solid #d5dbe5; padding-bottom: 3px; margin-bottom: 6px; }
    article { margin-bottom: 9px; }
    h3 { font-size: 10.5pt; }
    .when { font-size: 9pt; color: #666; }
    .sub { color: #555; font-size: 9.5pt; }
    .skills dt { font-weight: 600; }
  `,
};

const editorial: Theme = {
  id: "editorial",
  label: "Editorial",
  description: "Serif, centred masthead, spaced capitals",
  accent: "#7a1f2b",
  css: `
    @page { margin: 16mm 18mm; }
    body { font: 10.5pt/1.5 ${SERIF}; color: #222; }
    header.top { text-align: center; padding-bottom: 10px; border-bottom: 2px solid #222; }
    h1 { font-size: 26pt; font-weight: 400; letter-spacing: 0.04em; }
    .label { font-style: italic; font-size: 12pt; color: #555; margin-top: 2px; }
    .contacts { font-size: 9.5pt; color: #444; margin-top: 8px; }
    .contact { justify-content: center; }
    .contact li + li::before { content: "·"; margin-right: 12px; color: #aaa; }
    section { margin-top: 16px; }
    h2 { text-transform: uppercase; font-weight: 400; font-size: 10.5pt; letter-spacing: 0.06em; color: var(--accent);
         margin-bottom: 6px; display: flex; align-items: center; gap: 10px; }
    h2::after { content: ""; flex: 1; border-top: 0.5px solid #bbb; }
    article { margin-bottom: 10px; }
    h3 { font-size: 11pt; font-weight: 700; }
    .when { font-style: italic; font-size: 9.5pt; color: #666; }
    .sub { font-style: italic; color: #555; }
    li::marker { color: var(--accent); }
    .skills dt { text-transform: uppercase; font-size: 9pt; letter-spacing: 0.03em; }
  `,
};

const sidebar: Theme = {
  id: "sidebar",
  label: "Sidebar",
  description: "Two columns: contact, skills & education on the left (less ATS-friendly)",
  accent: "#0f766e",
  sidebar: ["contact", "skills", "education", "awards", "languages", "interests"],
  css: `
    @page { margin: 14mm 14mm; }
    body { font: 9.5pt/1.45 ${SANS}; }
    header.top { padding-bottom: 10px; margin-bottom: 14px; border-bottom: 3px solid var(--accent); }
    h1 { font-size: 24pt; color: var(--accent); letter-spacing: -0.02em; line-height: 1.1; }
    .label { font-size: 11pt; color: #444; margin-top: 3px; }
    .side .contact { flex-direction: column; gap: 1px; color: #444; overflow-wrap: anywhere; }
    .side .contact + .contact { margin-top: 6px; }
    section { margin-bottom: 14px; }
    h2 { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); margin-bottom: 6px; }
    .side { border-right: 1px solid #e3e3e3; padding-right: 16px; font-size: 9pt; }
    .side h3 { font-size: 9.5pt; }
    .side ul.inline { flex-direction: column; }
    article { margin-bottom: 9px; }
    h3 { font-size: 10.5pt; }
    .when { font-size: 8.5pt; color: #777; }
    .sub { color: #555; }
    .skills dt { font-weight: 600; }
    .skills dd { color: #444; }
  `,
};

const compact: Theme = {
  id: "compact",
  label: "Compact",
  description: "Dense, monospace accents; fits more on a page",
  accent: "#15803d",
  css: `
    @page { margin: 10mm 12mm; }
    body { font: 8.8pt/1.35 ${SANS}; }
    header.top { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }
    h1 { font: 700 16pt ${MONO}; letter-spacing: -0.03em; }
    h1::before { content: "> "; color: var(--accent); }
    .identity { display: flex; align-items: baseline; gap: 10px; }
    .label { font-family: ${MONO}; font-size: 9pt; color: #555; }
    .contacts { font-size: 8pt; color: #444; }
    .contact { gap: 2px 10px; }
    section { margin-top: 9px; }
    h2 { font: 700 8.5pt ${MONO}; color: var(--accent); margin-bottom: 3px; }
    h2::before { content: "## "; color: #aaa; }
    article { margin-bottom: 5px; }
    h3 { font-size: 9.3pt; }
    article header { justify-content: flex-start; }
    .when { font-family: ${MONO}; font-size: 7.8pt; color: #777; margin-left: auto; }
    ul { padding-left: 13px; margin-top: 1px; }
    li { margin: 0; }
    p { margin: 1px 0; }
    .skills dt { font-family: ${MONO}; font-size: 8.3pt; }
  `,
};

const banner: Theme = {
  id: "banner",
  label: "Banner",
  description: "Bold colour header band",
  accent: "#1e3a8a",
  css: `
    @page { margin: 12mm 14mm; }
    body { font: 10pt/1.45 ${SANS}; }
    header.top { background: var(--accent); color: #fff; border-radius: 6px; padding: 16px 20px; }
    h1 { font-size: 24pt; letter-spacing: -0.01em; }
    .label { font-size: 11.5pt; opacity: 0.85; margin-top: 2px; }
    .contacts { font-size: 9pt; margin-top: 10px; opacity: 0.9; }
    .main { padding: 0 4px; }
    section { margin-top: 16px; }
    h2 { font-size: 11pt; color: var(--accent); margin-bottom: 6px; padding-left: 8px; border-left: 3px solid var(--accent); }
    article { margin-bottom: 9px; }
    h3 { font-size: 10.5pt; }
    .when { font-size: 8.5pt; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, white);
            padding: 1px 7px; border-radius: 99px; }
    .sub { color: #555; font-size: 9.5pt; }
    li::marker { color: var(--accent); }
    .skills dt { font-weight: 600; }
  `,
};

export const THEMES: Theme[] = [classic, editorial, sidebar, compact, banner];

export const themeById = (id?: string) => THEMES.find((t) => t.id === id);

export const ACCENTS: { value: string; label: string }[] = [
  { value: "#2b5797", label: "Blue" },
  { value: "#0f766e", label: "Teal" },
  { value: "#15803d", label: "Green" },
  { value: "#7a1f2b", label: "Burgundy" },
  { value: "#6d28d9", label: "Violet" },
  { value: "#c2410c", label: "Orange" },
  { value: "#1f2937", label: "Charcoal" },
];
