import { z } from "zod";
import * as S from "./schema.ts";

export type FieldKind = "text" | "multiline" | "date" | "list" | "tags";

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  hint?: string;
}

export interface Section {
  key: SectionKey;
  label: string;
  schema: z.ZodObject;
  fields: Field[];
  /** Has date fields, so it can be sorted newest first. */
  dated: boolean;
  title: (item: Record<string, any>) => string;
}

export type SectionKey = Exclude<keyof S.Resume, "$schema" | "basics" | "meta">;

const MULTILINE = new Set(["summary", "description", "reference"]);

const humanise = (key: string) =>
  key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

// Build editor fields from the Zod shape: optional-ness, string vs string[], hints.
export function fieldsFor(schema: z.ZodObject): Field[] {
  return Object.entries(schema.shape).flatMap(([key, raw]) => {
    const required = !(raw instanceof z.ZodOptional);
    const inner = raw instanceof z.ZodOptional ? raw.unwrap() : raw;
    const hint = (raw as z.ZodType).description ?? (inner as z.ZodType).description;
    let kind: FieldKind;
    if (key === "tags") kind = "tags";
    else if (inner instanceof z.ZodArray && inner.element instanceof z.ZodString) kind = "list";
    else if (inner instanceof z.ZodString) {
      kind = /(^date$|Date$)/.test(key) ? "date" : MULTILINE.has(key) ? "multiline" : "text";
    } else return []; // nested objects (e.g. basics.location) are edited separately
    return [{ key, label: humanise(key), kind, required, hint }];
  });
}

const section = (
  key: SectionKey,
  label: string,
  schema: z.ZodObject,
  title: Section["title"],
): Section => {
  const fields = fieldsFor(schema);
  return { key, label, schema, fields, dated: fields.some((f) => f.kind === "date"), title };
};

const dated = (main: string, sub?: string, date?: string) =>
  [main, sub && `— ${sub}`, date && `(${date})`].filter(Boolean).join(" ");

export const SECTIONS: Section[] = [
  section("work", "Work", S.Work, (i) => dated(i.name, i.position, i.startDate)),
  section("projects", "Projects", S.Project, (i) => dated(i.name, undefined, i.startDate)),
  section("publications", "Talks & articles", S.Publication, (i) =>
    dated(i.name, i.publisher, i.releaseDate),
  ),
  section("education", "Education", S.Education, (i) => dated(i.institution, i.area, i.startDate)),
  section("skills", "Skills", S.Skill, (i) => dated(i.name, i.keywords?.join(", "))),
  section("volunteer", "Volunteer", S.Volunteer, (i) =>
    dated(i.organization, i.position, i.startDate),
  ),
  section("awards", "Awards", S.Award, (i) => dated(i.title, i.awarder, i.date)),
  section("certificates", "Certificates", S.Certificate, (i) => dated(i.name, i.issuer, i.date)),
  section("languages", "Languages", S.Language, (i) => dated(i.language, i.fluency)),
  section("interests", "Interests", S.Interest, (i) => i.name),
  section("references", "References", S.Reference, (i) => i.name),
];

export const sectionByKey = (key: SectionKey) => SECTIONS.find((s) => s.key === key)!;
