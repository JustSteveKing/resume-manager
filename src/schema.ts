import { z } from "zod";

// JSON Resume schema (https://jsonresume.org/schema), expressed in Zod so the same
// definition drives validation, the TUI editor, and Tabstack extraction schemas.

const isoDate = z
  .string()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "Use YYYY, YYYY-MM or YYYY-MM-DD")
  .describe("ISO 8601 date: YYYY, YYYY-MM or YYYY-MM-DD");

const url = z.string().describe("Absolute URL");
const list = (description: string) => z.array(z.string()).describe(description);

// resume-manager extension: used by variants to pick entries (e.g. "api", "leadership").
const tags = z.array(z.string()).optional().describe("Variant tags");

export const Location = z.object({
  address: z.string().optional(),
  postalCode: z.string().optional(),
  city: z.string().optional(),
  countryCode: z.string().optional().describe("ISO 3166-1 alpha-2 code, e.g. GB, US"),
  region: z.string().optional().describe("State, province or county"),
});

export const Profile = z.object({
  network: z.string().optional().describe("Network name, e.g. GitHub, LinkedIn, Mastodon"),
  username: z.string().optional(),
  url: url.optional(),
});

export const Basics = z.object({
  name: z.string().optional().describe("Full name of the person"),
  label: z.string().optional().describe("Professional title, e.g. Staff Engineer"),
  image: url.optional().describe("URL to a profile photo"),
  email: z.string().optional(),
  phone: z.string().optional(),
  url: url.optional().describe("Personal website URL"),
  summary: z.string().optional().describe("Short 2-3 sentence professional bio"),
  location: Location.optional(),
  profiles: z.array(Profile).optional().describe("Social and professional profiles"),
});

export const Work = z.object({
  name: z.string().describe("Company or organisation name"),
  position: z.string().optional().describe("Job title"),
  url: url.optional().describe("Company website"),
  location: z.string().optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional().describe("ISO 8601 end date; omit if current role"),
  summary: z.string().optional().describe("Overview of responsibilities"),
  highlights: list("Accomplishments, one short sentence each").optional(),
  tags,
});

export const Volunteer = z.object({
  organization: z.string().describe("Organisation name"),
  position: z.string().optional(),
  url: url.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  summary: z.string().optional(),
  highlights: list("Accomplishments, one short sentence each").optional(),
  tags,
});

export const Education = z.object({
  institution: z.string().describe("School, college or university"),
  url: url.optional(),
  area: z.string().optional().describe("Field of study, e.g. Computer Science"),
  studyType: z.string().optional().describe("Degree type, e.g. Bachelor, Master"),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  score: z.string().optional().describe("Grade or GPA"),
  courses: list("Notable courses").optional(),
});

export const Award = z.object({
  title: z.string(),
  date: isoDate.optional(),
  awarder: z.string().optional(),
  summary: z.string().optional(),
});

export const Certificate = z.object({
  name: z.string(),
  date: isoDate.optional(),
  issuer: z.string().optional(),
  url: url.optional(),
});

export const Publication = z.object({
  name: z.string().describe("Title of the article, book, talk or paper"),
  publisher: z.string().optional().describe("Publication, site or conference name"),
  releaseDate: isoDate.optional(),
  url: url.optional(),
  summary: z.string().optional(),
  tags,
});

export const Skill = z.object({
  name: z.string().describe("Skill area, e.g. Backend Development"),
  level: z.string().optional().describe("e.g. Expert, Advanced"),
  keywords: list("Specific technologies or tools").optional(),
  tags,
});

export const Language = z.object({
  language: z.string(),
  fluency: z.string().optional().describe("e.g. Native, Fluent, Conversational"),
});

export const Interest = z.object({
  name: z.string(),
  keywords: list("Related keywords").optional(),
});

export const Reference = z.object({
  name: z.string(),
  reference: z.string().optional().describe("The reference text"),
});

export const Project = z.object({
  name: z.string().describe("Project name"),
  description: z.string().optional().describe("One or two sentence description"),
  url: url.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  highlights: list("Notable outcomes or features").optional(),
  keywords: list("Technologies used").optional(),
  roles: list("Roles held, e.g. Maintainer, Creator").optional(),
  tags,
});

export const Source = z.object({
  url: z.string(),
  /** "basics" or a section key such as "publications". */
  target: z.string(),
  effort: z.enum(["min", "standard", "max"]).optional(),
  lastRun: z.string().optional(),
});

export const Resume = z.object({
  $schema: z.string().optional(),
  basics: Basics.default({}),
  work: z.array(Work).default([]),
  volunteer: z.array(Volunteer).default([]),
  education: z.array(Education).default([]),
  awards: z.array(Award).default([]),
  certificates: z.array(Certificate).default([]),
  publications: z.array(Publication).default([]),
  skills: z.array(Skill).default([]),
  languages: z.array(Language).default([]),
  interests: z.array(Interest).default([]),
  references: z.array(Reference).default([]),
  projects: z.array(Project).default([]),
  meta: z
    .object({
      canonical: z.string().optional(),
      version: z.string().optional(),
      lastModified: z.string().optional(),
      // resume-manager's last PDF export choices (JSON Resume allows extra meta keys).
      pdf: z
        .object({
          theme: z.string().optional(),
          accent: z.string().optional(),
          paper: z.enum(["A4", "Letter"]).optional(),
        })
        .optional(),
      // Saved Tabstack import sources, re-run by "Refresh sources".
      sources: z.array(Source).optional(),
    })
    .optional(),
});

export type Resume = z.infer<typeof Resume>;
export type Basics = z.infer<typeof Basics>;
export type Work = z.infer<typeof Work>;
export type Skill = z.infer<typeof Skill>;
export type Project = z.infer<typeof Project>;
export type Source = z.infer<typeof Source>;
