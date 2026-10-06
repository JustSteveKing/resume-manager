import { formatDate, formatRange } from "../dates.ts";
import { BLOCK_IDS, type BlockId, type ResumeView } from "./blocks.ts";

// Plain text for ATS paste-in forms: no tables, no columns, predictable headings.
export function renderText(r: ResumeView): string {
  const b = r.basics;
  const line = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" | ");
  const bullets = (items?: string[]) => (items ?? []).map((i) => `  - ${i}`);
  const heading = (t: string, body: (string | undefined)[]) => {
    const lines = body.filter((l): l is string => l !== undefined && l !== "");
    return lines.length ? ["", t.toUpperCase(), "-".repeat(t.length), ...lines] : [];
  };

  const blocks: Record<BlockId, string[]> = {
    contact: [
      line([b.location?.city, b.location?.region, b.location?.countryCode].filter(Boolean).join(", "), b.email, b.phone, b.url),
      ...(b.profiles ?? []).map((p) => line(p.network, p.url)),
    ],
    summary: heading("Summary", [b.summary]),
    experience: heading("Experience", r.work.flatMap((w) => [
      "",
      line(w.position, w.name, w.location),
      formatRange(w.startDate, w.endDate),
      w.summary,
      ...bullets(w.highlights),
    ])),
    earlier: heading("Earlier Career", (r.earlierCareer ?? []).map((w) =>
      line(w.position, w.name, formatRange(w.startDate, w.endDate)),
    )),
    projects: heading("Projects", r.projects.flatMap((p) => [
      "",
      line(p.name, p.url, formatRange(p.startDate, p.endDate)),
      p.description,
      ...bullets(p.highlights),
      p.keywords?.length ? `  Technologies: ${p.keywords.join(", ")}` : undefined,
    ])),
    skills: heading("Skills", r.skills.map((s) => `${s.name}: ${s.keywords?.join(", ") ?? s.level ?? ""}`.trim())),
    publications: heading("Publications & Talks", r.publications.map((p) =>
      line(p.name, p.publisher, formatDate(p.releaseDate), p.url),
    )),
    education: heading("Education", r.education.map((e) =>
      line([e.studyType, e.area].filter(Boolean).join(", "), e.institution, formatRange(e.startDate, e.endDate)),
    )),
    volunteer: heading("Volunteering", r.volunteer.flatMap((v) => [
      line(v.position, v.organization, formatRange(v.startDate, v.endDate)),
      ...bullets(v.highlights),
    ])),
    awards: heading("Awards & Certificates", [
      ...r.awards.map((a) => line(a.title, a.awarder, formatDate(a.date))),
      ...r.certificates.map((c) => line(c.name, c.issuer, formatDate(c.date))),
    ]),
    languages: heading("Languages", [
      r.languages.map((l) => (l.fluency ? `${l.language} (${l.fluency})` : l.language)).join(", "),
    ]),
    interests: heading("Interests", [r.interests.map((i) => i.name).join(", ")]),
  };

  const order = r.blockOrder ?? BLOCK_IDS.filter((id) => id !== "contact");
  const out = [b.name, b.label, ...blocks.contact, ...order.filter((id) => id !== "contact").flatMap((id) => blocks[id])];
  return out.filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
