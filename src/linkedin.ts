import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResumeView } from "./export/blocks.ts";
import { formatRange } from "./dates.ts";

// LinkedIn: import a "Download your data" export (ZIP or unzipped folder of CSVs) as a raw
// JSON Resume object for the normal importer, and export copy sized to LinkedIn's limits.

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  // Some LinkedIn files start with a "Notes:" preamble before the header row.
  const headerAt = rows.findIndex((r) => r.length > 1);
  const [header, ...body] = rows.slice(Math.max(0, headerAt));
  if (!header) return [];
  return body
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** Read CSVs from an unzipped export folder or a .zip (via the system `unzip`). */
async function readExport(path: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  if (/\.zip$/i.test(path)) {
    const list = Bun.spawn(["unzip", "-Z1", path], { stdout: "pipe", stderr: "pipe" });
    const names = (await new Response(list.stdout).text()).split("\n").filter((n) => /\.csv$/i.test(n));
    if ((await list.exited) !== 0) throw new Error(`Couldn't read ${path} (is \`unzip\` installed?)`);
    for (const name of names) {
      const proc = Bun.spawn(["unzip", "-p", path, name], { stdout: "pipe" });
      files[name.split("/").pop()!] = await new Response(proc.stdout).text();
    }
  } else {
    for (const name of await readdir(path)) if (/\.csv$/i.test(name)) files[name] = await Bun.file(join(path, name)).text();
  }
  return files;
}

export async function isLinkedInExport(path: string): Promise<boolean> {
  if (/\.zip$/i.test(path)) return Bun.file(path).exists();
  try {
    if (!(await stat(path)).isDirectory()) return false;
    const names = await readdir(path);
    return names.includes("Positions.csv") || names.includes("Profile.csv");
  } catch {
    return false;
  }
}

/** LinkedIn descriptions: bullet lines become highlights, the rest the summary. */
export function splitDescription(text: string): { summary?: string; highlights?: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullet = /^[•\-*–▪●◦]\s*/;
  const highlights = lines.filter((l) => bullet.test(l)).map((l) => l.replace(bullet, ""));
  const summary = lines.filter((l) => !bullet.test(l)).join(" ");
  return { summary: summary || undefined, highlights: highlights.length ? highlights : undefined };
}

const urlsIn = (s = "") => [...s.matchAll(/https?:\/\/[^\s,\]]+/g)].map((m) => m[0]);

/** Convert a LinkedIn export to a raw JSON Resume object (validated later by the importer). */
export async function linkedInToJsonResume(path: string): Promise<Record<string, unknown>> {
  const files = await readExport(path);
  const csv = (name: string) => (files[name] ? parseCsv(files[name]!) : []);
  const profile = csv("Profile.csv")[0] ?? {};
  const emails = csv("Email Addresses.csv");
  const email = (emails.find((e) => e["Primary"] === "Yes") ?? emails[0])?.["Email Address"];
  const sites = urlsIn(profile["Websites"]);

  return {
    basics: {
      name: [profile["First Name"], profile["Last Name"]].filter(Boolean).join(" ") || undefined,
      label: profile["Headline"] || undefined,
      summary: profile["Summary"] || undefined,
      email,
      url: sites[0],
      location: profile["Geo Location"] ? { city: profile["Geo Location"] } : undefined,
      profiles: profile["Twitter Handles"] ? [{ network: "Twitter", username: profile["Twitter Handles"].replace(/[[\]@]/g, "") }] : undefined,
    },
    work: csv("Positions.csv").map((p) => ({
      name: p["Company Name"],
      position: p["Title"],
      location: p["Location"] || undefined,
      startDate: p["Started On"] || undefined,
      endDate: p["Finished On"] || undefined,
      ...splitDescription(p["Description"] ?? ""),
    })),
    education: csv("Education.csv").map((e) => ({
      institution: e["School Name"],
      studyType: e["Degree Name"] || undefined,
      startDate: e["Start Date"] || undefined,
      endDate: e["End Date"] || undefined,
    })),
    skills: (() => {
      const names = csv("Skills.csv").map((s) => s["Name"]).filter(Boolean);
      return names.length ? [{ name: "LinkedIn skills", keywords: names }] : [];
    })(),
    projects: csv("Projects.csv").map((p) => ({
      name: p["Title"],
      description: p["Description"] || undefined,
      url: p["Url"] || undefined,
      startDate: p["Started On"] || undefined,
      endDate: p["Finished On"] || undefined,
    })),
    publications: csv("Publications.csv").map((p) => ({
      name: p["Name"],
      publisher: p["Publisher"] || undefined,
      releaseDate: p["Published On"] || undefined,
      url: p["Url"] || undefined,
      summary: p["Description"] || undefined,
    })),
    certificates: csv("Certifications.csv").map((c) => ({
      name: c["Name"],
      issuer: c["Authority"] || undefined,
      date: c["Started On"] || undefined,
      url: c["Url"] || undefined,
    })),
    languages: csv("Languages.csv").map((l) => ({ language: l["Name"], fluency: l["Proficiency"] || undefined })),
    awards: csv("Honors.csv").map((h) => ({ title: h["Title"], summary: h["Description"] || undefined, date: h["Issued On"] || undefined })),
    volunteer: csv("Volunteering.csv").map((v) => ({
      organization: v["Company Name"],
      position: v["Role"] || undefined,
      startDate: v["Started On"] || undefined,
      endDate: v["Finished On"] || undefined,
      summary: v["Description"] || undefined,
    })),
  };
}

// ---------- export ----------

export const LINKEDIN_LIMITS = { headline: 220, about: 2600, description: 2000 };

const clip = (s: string, n: number) => (s.length <= n ? { text: s, over: 0 } : { text: `${s.slice(0, n - 1).trimEnd()}…`, over: s.length - n });

/** Paste-ready LinkedIn copy (markdown), with a warning wherever text exceeds LinkedIn's limits. */
export function renderLinkedIn(r: ResumeView): string {
  const out: string[] = ["# LinkedIn copy", "", "Paste each block into the matching LinkedIn field. Character counts are shown against LinkedIn's limits.", ""];
  const block = (title: string, text: string, limit: number, heading = "##") => {
    const c = clip(text, limit);
    out.push(`${heading} ${title} (${text.length}/${limit})${c.over ? ` ⚠ ${c.over} over, trimmed` : ""}`, "", "```", c.text, "```", "");
  };
  if (r.basics.label) block("Headline", r.basics.label, LINKEDIN_LIMITS.headline);
  if (r.basics.summary) block("About", r.basics.summary, LINKEDIN_LIMITS.about);
  out.push("## Experience", "");
  for (const w of r.work) {
    out.push(`### ${w.position ?? ""} · ${w.name}`, `${formatRange(w.startDate, w.endDate)}${w.location ? ` · ${w.location}` : ""}`, "");
    const desc = [w.summary, ...(w.highlights ?? []).map((h) => `• ${h}`)].filter(Boolean).join("\n");
    if (desc) block("Description", desc, LINKEDIN_LIMITS.description, "####");
  }
  if (r.projects.length) {
    out.push("## Projects", "");
    for (const p of r.projects) {
      const desc = [p.description, ...(p.highlights ?? []).map((h) => `• ${h}`)].filter(Boolean).join("\n");
      out.push(`### ${p.name}${p.url ? ` (${p.url})` : ""}`, "");
      if (desc) block("Description", desc, LINKEDIN_LIMITS.description, "####");
    }
  }
  const skills = r.skills.flatMap((s) => s.keywords ?? [s.name]);
  if (skills.length) out.push("## Skills", "", `LinkedIn shows your top skills first; pick from: ${skills.slice(0, 50).join(", ")}`, "");
  return out.join("\n");
}
