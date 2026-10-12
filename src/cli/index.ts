import type { HomeSource } from "../config.ts";
import { THEMES } from "../export/themes.ts";
import { parse, type CommandContext } from "./context.ts";
import { print } from "./output.ts";
import { cmdInit, cmdWhere, cmdDoctor, cmdConfig, cmdSpend } from "./setup.ts";
import { cmdValidate, cmdVariants, cmdExport, cmdSkills, cmdEvidence, cmdRewrite, cmdImport } from "./resume.ts";
import { cmdTailor, cmdApps, cmdPrep } from "./apply.ts";
import { cmdRefresh, cmdInbox, cmdScan } from "./grow.ts";

export const HELP = `resume-manager

Usage:
  cv                              Interactive TUI (or \`bun start\` inside the repo)
  cv <command> [options]

Setup:
  init [folder]                   Remember where your resume lives, so \`cv\` works from any folder
  where                           Show which folder and files are in use
  doctor [--live] [--tabstack]    Check setup; --live tests keys (free), --tabstack also tests Tabstack (paid call)
  config ai <auto|ollama|tabstack>
  config ollama-model <name|off>  Local model for writing features (default qwen3:8b)
  config ollama-host <url|off>    Ollama server (default http://localhost:11434)
  config budget <usd|off>         Monthly cap on Tabstack spend (Research is the priced call)
  config key <tabstack|github|gitlab|ichabod> <value|off>
  config pdf-browser <local|ichabod>  Print exported PDFs with local Chrome or Ichabod (Mozilla cloud browser)
  config ichabod-host <host|off>  Ichabod API host
  config gitlab-host <url|off>    Self-hosted GitLab (default gitlab.com)
  spend                           Tabstack spend this month (writing on Ollama is free)

Commands:
  validate [--strict]             Schema + content + writing checks. Exit 1 on errors (or warnings with --strict)
  export [options]                Export the full resume and/or variants
      --variant <name>            Variant from variants/ (repeatable). Default: full resume
      --all                       Full resume plus every variant
      --theme <id|all>            ${THEMES.map((t) => t.id).join(", ")}
      --accent <#hex>  --paper <A4|Letter>
      --format <list>             pdf,html,json,text,linkedin (default: pdf)
      --pages <n> [--fit]         Warn above n pages; --fit trims content until it fits
      --ats                       Check PDF text extraction; exit 1 if it fails
  variants                        List variants
  tailor <url> [options]          Extract a job posting, report keyword coverage, write a tailored variant
      --base <variant>            Start from an existing variant
      --name <name>               Variant name (default: from job title/company)
      --write                     Generate tailored headline, summary and cover letter (Tabstack generate)
      --research                  Company research via Tabstack Research (~$2 per run)
  refresh [--yes]                 Re-run saved import sources; --yes adds all new entries
  skills [--add]                  Suggest skills found in your resume; --add appends them
  import <file|url|user> [opts]   Import a JSON Resume (file, URL, gist, registry user) or a LinkedIn data export (.zip/folder)
      (no flags)                  Dry run: show what would change
      --yes                       Merge: add new entries, fill empty basics, keep yours
      --replace --yes             Replace resume.json entirely (backup written first)
  scan [options]                  Scan your GitHub and GitLab (from Basics → Profiles): skills from real
                                  dependencies, a ranked portfolio and write-ups. Mirrors count once
      --github <user> --gitlab <user> --gitlab-host <host>   override the accounts
  github [username] [options]     GitHub only
  gitlab [username] [--gitlab-host <host>]   GitLab only (gitlab.com or self-hosted)
      --top <n>                   Portfolio size (default 8)
      --no-ai                     Skip Tabstack generate; facts and rankings only
      --refresh                   Ignore the 24h cache
      --yes                       Add new projects and skills to resume.json
  evidence [--all]                What backs up each skill; flags unsupported, stale and unlisted skills
  rewrite "<text>" [--summary]    Writing coach: 3 rewrites that keep the original facts
  apps [list|stats]               Applications: status, follow-ups due, what's working
  apps status <slug> <status>     draft|applied|interview|offer|rejected|withdrawn
  apps followup <slug> <date|+N>  Set a follow-up date
  prep <slug>                     Interview prep for an application (writes interview-prep.md)
  inbox [--yes]                   Check sources and GitHub for new achievements; --yes accepts all
  help                            Show this help

AI features (rewrite, prep, interview drafting) run locally on Ollama (default qwen3:8b).
Tabstack generate is used only if you choose it: cv config ai tabstack (or RESUME_AI=tabstack).
`;

const COMMANDS: Record<string, (ctx: CommandContext) => Promise<number>> = {
  init: cmdInit,
  where: cmdWhere,
  doctor: cmdDoctor,
  config: cmdConfig,
  spend: cmdSpend,
  validate: cmdValidate,
  variants: cmdVariants,
  export: cmdExport,
  skills: cmdSkills,
  evidence: cmdEvidence,
  rewrite: cmdRewrite,
  import: cmdImport,
  tailor: cmdTailor,
  apps: cmdApps,
  prep: cmdPrep,
  refresh: cmdRefresh,
  inbox: cmdInbox,
  scan: cmdScan,
  github: cmdScan,
  gitlab: cmdScan,
};

export async function runCommand(argv: string[], env?: { home: string; source: HomeSource }): Promise<number> {
  const [command = "help", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    print(HELP);
    return 0;
  }
  const run = COMMANDS[command];
  if (!run) {
    print(`Unknown command "${command}"\n`);
    print(HELP);
    return 1;
  }
  return run({ ...parse(rest), command, env });
}
