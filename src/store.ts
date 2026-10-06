import { z } from "zod";
import { Resume } from "./schema.ts";

export const RESUME_PATH = process.env.RESUME_PATH ?? "resume.json";
const SCHEMA_URL =
  "https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json";

export async function load(path = RESUME_PATH): Promise<Resume> {
  const file = Bun.file(path);
  if (!(await file.exists())) return Resume.parse({ $schema: SCHEMA_URL });
  const result = Resume.safeParse(await file.json());
  if (!result.success) {
    throw new Error(`${path} is not a valid JSON Resume:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function save(resume: Resume, path = RESUME_PATH) {
  const out = Resume.parse({
    ...resume,
    $schema: resume.$schema ?? SCHEMA_URL,
    meta: { ...resume.meta, lastModified: new Date().toISOString() },
  });
  await Bun.write(path, JSON.stringify(prune(out), null, 2) + "\n");
}

// Drop empty strings, empty arrays and empty objects so the file stays tidy.
export function prune<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(prune).filter((v) => !isEmpty(v)) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([k, v]) => [k, prune(v)] as const)
      .filter(([, v]) => !isEmpty(v));
    return Object.fromEntries(entries) as T;
  }
  return typeof value === "string" ? (value.trim() as T) : value;
}

function isEmpty(v: unknown) {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}
