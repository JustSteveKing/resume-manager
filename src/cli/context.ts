import { parseArgs } from "node:util";
import type { HomeSource } from "../config.ts";

/** Every option any command accepts (parseArgs needs them up front). */
export const OPTIONS = {
  strict: { type: "boolean" },
  variant: { type: "string", multiple: true },
  all: { type: "boolean" },
  theme: { type: "string" },
  accent: { type: "string" },
  paper: { type: "string" },
  format: { type: "string" },
  pages: { type: "string" },
  fit: { type: "boolean" },
  ats: { type: "boolean" },
  base: { type: "string" },
  name: { type: "string" },
  write: { type: "boolean" },
  research: { type: "boolean" },
  yes: { type: "boolean" },
  add: { type: "boolean" },
  top: { type: "string" },
  "no-ai": { type: "boolean" },
  refresh: { type: "boolean" },
  replace: { type: "boolean" },
  summary: { type: "boolean" },
  github: { type: "string" },
  gitlab: { type: "string" },
  "gitlab-host": { type: "string" },
  live: { type: "boolean" },
  tabstack: { type: "boolean" },
} as const;

export const parse = (args: string[]) => parseArgs({ args, allowPositionals: true, options: OPTIONS });

export type CommandContext = ReturnType<typeof parse> & {
  command: string;
  env?: { home: string; source: HomeSource };
};
