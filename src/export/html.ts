import { formatDate, formatRange } from "../dates.ts";
import type { Resume } from "../schema.ts";
import { BLOCK_IDS, type BlockId, type ResumeView } from "./blocks.ts";
import { THEMES, type Theme } from "./themes.ts";

const esc = (s = "") =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const link = (href?: string, text?: string) =>
  href ? `<a href="${esc(href)}">${esc(text ?? href.replace(/^https?:\/\/(www\.)?/, ""))}</a>` : esc(text);

const bullets = (items?: string[]) =>
  items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";

const para = (s?: string) => (s ? `<p>${esc(s)}</p>` : "");

const section = (id: BlockId, title: string, body: string) =>
  body ? `<section class="s-${id}"><h2>${title}</h2>${body}</section>` : "";

const entry = (head: string, sub: string, when: string, body: string) => `
  <article>
    <header><h3>${head}</h3><span class="when">${esc(when)}</span></header>
    ${sub ? `<div class="sub">${sub}</div>` : ""}
    ${body}
  </article>`;

// Each block renders one resume section; themes decide which column it lands in.
function blocks(r: ResumeView): Record<BlockId, string> {
  const b = r.basics;
  return {
    contact: section("contact", "Contact", contactLists(b)),
    summary: section("summary", "Summary", para(b.summary)),
    experience: section(
      "experience",
      "Experience",
      r.work
        .map((w) =>
          entry(esc(w.position ?? w.name), [link(w.url, w.name), esc(w.location)].filter(Boolean).join(" · "),
            formatRange(w.startDate, w.endDate), para(w.summary) + bullets(w.highlights)),
        )
        .join(""),
    ),
    earlier: section(
      "earlier",
      "Earlier Career",
      r.earlierCareer?.length
        ? `<ul class="earlier">${r.earlierCareer
            .map((w) => `<li><span>${esc([w.position, w.name].filter(Boolean).join(", "))}</span><span class="when">${esc(formatRange(w.startDate, w.endDate))}</span></li>`)
            .join("")}</ul>`
        : "",
    ),
    projects: section(
      "projects",
      "Projects",
      r.projects
        .map((p) =>
          entry(link(p.url, p.name), esc(p.keywords?.join(", ")), formatRange(p.startDate, p.endDate),
            para(p.description) + bullets(p.highlights)),
        )
        .join(""),
    ),
    skills: section(
      "skills",
      "Skills",
      r.skills.length
        ? `<dl class="skills">${r.skills
            .map((s) => `<div><dt>${esc(s.name)}</dt><dd>${esc(s.keywords?.join(", ") ?? s.level)}</dd></div>`)
            .join("")}</dl>`
        : "",
    ),
    publications: section(
      "publications",
      "Publications & Talks",
      r.publications
        .map((p) => entry(link(p.url, p.name), esc(p.publisher), formatDate(p.releaseDate), para(p.summary)))
        .join(""),
    ),
    education: section(
      "education",
      "Education",
      r.education
        .map((e) =>
          entry(esc(e.institution), esc([e.studyType, e.area].filter(Boolean).join(", ")),
            formatRange(e.startDate, e.endDate), bullets(e.courses)),
        )
        .join(""),
    ),
    volunteer: section(
      "volunteer",
      "Volunteering",
      r.volunteer
        .map((v) =>
          entry(esc(v.position ?? v.organization), link(v.url, v.organization), formatRange(v.startDate, v.endDate),
            para(v.summary) + bullets(v.highlights)),
        )
        .join(""),
    ),
    awards: section(
      "awards",
      "Awards & Certificates",
      [
        ...r.awards.map((a) => entry(esc(a.title), esc(a.awarder), formatDate(a.date), para(a.summary))),
        ...r.certificates.map((c) => entry(link(c.url, c.name), esc(c.issuer), formatDate(c.date), "")),
      ].join(""),
    ),
    languages: section(
      "languages",
      "Languages",
      r.languages.length
        ? `<ul class="inline">${r.languages
            .map((l) => `<li>${esc([l.language, l.fluency && `(${l.fluency})`].filter(Boolean).join(" "))}</li>`)
            .join("")}</ul>`
        : "",
    ),
    interests: section(
      "interests",
      "Interests",
      r.interests.length ? `<ul class="inline">${r.interests.map((i) => `<li>${esc(i.name)}</li>`).join("")}</ul>` : "",
    ),
  };
}

export interface RenderOptions {
  theme?: Theme;
  /** CSS colour overriding the theme's accent. */
  accent?: string;
}

// Contact details and profiles as two lists, so each wraps as its own row.
function contactLists(b: Resume["basics"]): string {
  const loc = [b.location?.city, b.location?.region, b.location?.countryCode].filter(Boolean).join(", ");
  const details = [
    loc && esc(loc),
    b.email && link(`mailto:${b.email}`, b.email),
    b.phone && esc(b.phone),
    b.url && link(b.url),
  ].filter(Boolean);
  const profiles = (b.profiles ?? []).map((p) =>
    link(p.url, p.network ? `${p.network}: ${p.username ?? ""}`.trim() : p.url),
  );
  return [details, profiles]
    .filter((l) => l.length)
    .map((l) => `<ul class="contact">${l.map((c) => `<li>${c}</li>`).join("")}</ul>`)
    .join("");
}

export function renderHtml(r: ResumeView, { theme = THEMES[0]!, accent }: RenderOptions = {}): string {
  const b = r.basics;
  const html = blocks(r);
  // Variants choose which blocks appear and in what order; themes choose which column.
  const order = r.blockOrder ?? BLOCK_IDS.filter((id) => id !== "contact");
  const visible = new Set<BlockId>(["contact", ...order]);
  const side = new Set((theme.sidebar ?? []).filter((id) => visible.has(id)));
  const main = order.filter((id) => !side.has(id)).map((id) => html[id]).join("");
  const aside = [...side].map((id) => html[id]).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(b.name ?? "Resume")}</title>
<style>
  :root { --accent: ${safeColour(accent) ?? theme.accent}; }
  ${BASE_CSS}
  ${theme.css}
</style>
</head>
<body class="theme-${theme.id}">
  <header class="top">
    <div class="identity">
      <h1>${esc(b.name)}</h1>
      ${b.label ? `<div class="label">${esc(b.label)}</div>` : ""}
    </div>
    ${side.has("contact") ? "" : `<div class="contacts">${contactLists(b)}</div>`}
  </header>
  ${aside
    ? `<div class="layout"><aside class="side">${aside}</aside><main class="main">${main}</main></div>`
    : `<main class="main">${main}</main>`}
</body>
</html>`;
}

// Accent ends up inside <style>, so only accept plain colour values.
export function safeColour(c?: string): string | undefined {
  if (!c) return undefined;
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim()) ? c.trim() : undefined;
}

// Structural CSS shared by every theme. Themes layer typography and colour on top.
const BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; color: #1a1a1a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  a { color: inherit; text-decoration: none; }
  h1, h2, h3, p { margin: 0; }
  ul { margin: 3px 0 0; padding-left: 16px; }
  li { margin: 1px 0; }
  .contacts { display: flex; flex-direction: column; gap: 2px; }
  .contact, ul.inline { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 2px 12px; }
  section { break-inside: auto; }
  h2 { break-after: avoid; }
  article { break-inside: avoid; }
  article header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .when { white-space: nowrap; }
  p { margin: 3px 0; }
  .skills { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
  .skills > div { display: contents; }
  .skills dd { margin: 0; }
  .layout { display: grid; grid-template-columns: 30% 1fr; gap: 0 22px; }
  .side .skills { display: block; }
  .side .skills > div { display: block; margin-bottom: 5px; }
  .side article header { display: block; }
  .side .when { display: block; }
  ul.earlier { list-style: none; padding: 0; }
  ul.earlier li { display: flex; justify-content: space-between; gap: 12px; }
  .side ul.earlier li { display: block; }
  /* Standalone HTML export: centre the page on screen. */
  @media screen {
    html { background: #f2f2f2; }
    body { max-width: 210mm; margin: 24px auto; padding: 16mm; background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
    @media (max-width: 720px) { body { margin: 0; padding: 20px; box-shadow: none; } .layout { display: block; } }
  }
`;
