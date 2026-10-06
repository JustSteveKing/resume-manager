import { parseArgs } from "node:util";
import { exportResume, PdfRenderer, type Format, type PaperSize, type PdfResult } from "./export/index.ts";
import { THEMES, themeById, type Theme } from "./export/themes.ts";
import { extractJob, generateTailored, jobCoverage, researchCompany, saveApplication, tailorVariant } from "./job.ts";
import { suggestSkills } from "./keywords.ts";
import { hasErrors, lint, type Issue } from "./lint.ts";
import type { Resume } from "./schema.ts";
import { refreshSources, sourceLabel } from "./sources.ts";
import { load, save } from "./store.ts";
import { listVariants, loadVariant, saveVariant, variantSlug, type Variant } from "./variants.ts";

export const HELP = `resume-manager

Usage:
  bun start                       Interactive TUI
  bun start <command> [options]

Commands:
  validate [--strict]             Schema + content + writing checks. Exit 1 on errors (or warnings with --strict)
  export [options]                Export the full resume and/or variants
      --variant <name>            Variant from variants/ (repeatable). Default: full resume
      --all                       Full resume plus every variant
      --theme <id|all>            ${THEMES.map((t) => t.id).join(", ")}
      --accent <#hex>  --paper <A4|Letter>
      --format <list>             pdf,html,json,text (default: pdf)
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
  help                            Show this help
`;

const print = (s = "") => console.log(s);
const ICON = { error: "✖", warn: "▲", info: "·" } as const;

export function printIssues(issues: Issue[]) {
  if (!issues.length) return print("✔ Valid JSON Resume, no issues");
  for (const group of ["schema", "content", "order", "writing"] as const) {
    const items = issues.filter((i) => i.group === group);
    if (!items.length) continue;
    print(`\n${group.toUpperCase()}`);
    items.forEach((i) => print(`  ${ICON[i.level]} ${i.message}`));
  }
}

export function describePdf(p: PdfResult): string[] {
  const lines = [`${p.file}: ${p.pages} page${p.pages === 1 ? "" : "s"}${p.overTarget ? " (over target)" : ""}`];
  if (p.fitted.length) lines.push(`  fitted by: ${p.fitted.join(", ")}`);
  if (p.ats) {
    const a = p.ats;
    lines.push(`  ATS: ${a.ok ? "✔ pass" : "✖ fail"}, ${Math.round(a.wordCoverage * 100)}% of words extracted`);
    if (a.missing.length) lines.push(`    missing: ${a.missing.join(" | ")}`);
    if (a.outOfOrder.length) lines.push(`    out of order: ${a.outOfOrder.join(" | ")}`);
  }
  return lines;
}

export async function runCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
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
    },
  });

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      print(HELP);
      return 0;

    case "validate": {
      const issues = lint(await load());
      printIssues(issues);
      return hasErrors(issues) || (values.strict && issues.some((i) => i.level === "warn")) ? 1 : 0;
    }

    case "variants": {
      const names = await listVariants();
      if (!names.length) print("No variants yet. Create one in the TUI or add variants/<name>.json");
      for (const n of names) {
        const v = await loadVariant(n);
        print(`${n}${v.label ? ` — ${v.label}` : ""}${v.description ? `\n  ${v.description}` : ""}`);
      }
      return 0;
    }

    case "export": {
      const resume = await load();
      const formats = (values.format ?? "pdf").split(",").map((f) => f.trim()) as Format[];
      const bad = formats.filter((f) => !["pdf", "html", "json", "text"].includes(f));
      if (bad.length) throw new Error(`Unknown format: ${bad.join(", ")}`);

      let themes: Theme[] | undefined;
      if (values.theme === "all") themes = THEMES;
      else if (values.theme) {
        const t = themeById(values.theme);
        if (!t) throw new Error(`Unknown theme "${values.theme}". Options: ${THEMES.map((x) => x.id).join(", ")}`);
        themes = [t];
      }
      const paper = values.paper as PaperSize | undefined;
      if (paper && paper !== "A4" && paper !== "Letter") throw new Error("--paper must be A4 or Letter");
      const targetPages = values.pages ? Number(values.pages) : undefined;

      const jobs: { name?: string; variant?: Variant }[] = [];
      if (values.all || !values.variant?.length) jobs.push({});
      const names = values.all ? await listVariants() : (values.variant ?? []);
      for (const name of names) jobs.push({ name, variant: await loadVariant(name) });

      const last = resume.meta?.pdf ?? {};
      const renderer = new PdfRenderer();
      let failed = false;
      try {
        for (const job of jobs) {
          const res = await exportResume(
            {
              resume, variant: job.variant, variantName: job.name, formats,
              // Full resume falls back to the last TUI choices; variants use their own settings.
              themes: themes ?? (job.variant ? undefined : [themeById(last.theme) ?? THEMES[0]!]),
              accent: values.accent ?? (job.variant ? undefined : last.accent),
              paper: paper ?? (job.variant ? undefined : last.paper),
              targetPages, fit: values.fit, ats: values.ats,
            },
            renderer,
          );
          print(`\n${job.name ?? "full resume"}`);
          res.files.filter((f) => !f.endsWith(".pdf")).forEach((f) => print(`  ${f}`));
          res.pdfs.forEach((p) => describePdf(p).forEach((l) => print(`  ${l}`)));
          if (res.pdfs.some((p) => p.ats && !p.ats.ok)) failed = true;
        }
      } finally {
        await renderer.close();
      }
      return failed ? 1 : 0;
    }

    case "tailor": {
      const url = positionals[0];
      if (!url || !URL.canParse(url)) throw new Error("Usage: bun start tailor <job-url>");
      const resume = await load();
      print(`Extracting job posting from ${url}…`);
      const job = await extractJob(url);
      const cov = jobCoverage(resume, job);
      print(`${job.title ?? "Unknown role"} @ ${job.company ?? "unknown company"}`);
      print(`Keyword coverage ${Math.round(cov.ratio * 100)}%`);
      print(`  covered: ${cov.covered.join(", ") || "none"}`);
      print(`  missing: ${cov.missing.join(", ") || "none"}`);

      const base = values.base ? await loadVariant(values.base) : {};
      const variant = tailorVariant(job, url, base);
      const name = variantSlug(values.name ?? ([job.company, job.title].filter(Boolean).join(" ") || "tailored"));

      let tailored;
      if (values.write) {
        print("Writing tailored headline, summary and cover letter…");
        try {
          tailored = await generateTailored(url, resume, variant, job);
          variant.basics = { label: tailored.headline, summary: tailored.summary };
        } catch (e) {
          print(`  ▲ generation failed, continuing without it: ${e instanceof Error ? e.message : e}`);
        }
      }
      let research;
      if (values.research) {
        print("Researching company (Tabstack Research, ~$2)…");
        try {
          research = await researchCompany(job, (m) => print(`  ${m}`));
        } catch (e) {
          print(`  ▲ research failed, continuing without it: ${e instanceof Error ? e.message : e}`);
        }
      }

      await saveVariant(name, variant);
      const files = await saveApplication(name, { url, job, cov, tailored, research });
      print(`\nWrote variants/${name}.json`);
      files.forEach((f) => print(`Wrote ${f}`));
      print(`\nNext: bun start export --variant ${name} --ats`);
      return 0;
    }

    case "refresh": {
      const resume = await load();
      if (!resume.meta?.sources?.length) {
        print("No saved sources. Import from the TUI and choose \"save as source\".");
        return 0;
      }
      const results = await refreshSources(resume, (s) => print(`Fetching ${sourceLabel(s)}…`));
      let added = 0;
      for (const res of results) {
        if (res.kind === "error") print(`  ✖ ${sourceLabel(res.source)}: ${res.error}`);
        if (res.kind === "basics") print(`  ${sourceLabel(res.source)}: profile sources are only applied in the TUI`);
        if (res.kind === "items") {
          print(`  ${sourceLabel(res.source)}: ${res.fresh.length} new`);
          res.fresh.forEach((i) => print(`    + ${res.section.title(i)}`));
          if (values.yes && res.fresh.length) {
            (resume[res.section.key] as object[]).push(...res.fresh);
            added += res.fresh.length;
          }
        }
      }
      await save(resume); // records lastRun even when nothing is added
      if (added) print(`Added ${added} entr${added === 1 ? "y" : "ies"}. Run "bun start validate" to check ordering.`);
      else if (!values.yes && results.some((r) => r.kind === "items" && r.fresh.length)) print("Re-run with --yes to add them.");
      return 0;
    }

    case "skills": {
      const resume = await load();
      const suggestions = suggestSkills(resume);
      if (!suggestions.length) {
        print("No new skills found in your resume text.");
        return 0;
      }
      suggestions.forEach((s) => print(`${s.name}: ${s.keywords!.join(", ")}`));
      if (values.add) {
        mergeSkills(resume, suggestions);
        await save(resume);
        print("\nAdded to Skills.");
      } else print("\nRe-run with --add to add them, or pick individually in the TUI.");
      return 0;
    }

    default:
      print(`Unknown command "${command}"\n`);
      print(HELP);
      return 1;
  }
}

/** Add suggested keywords into existing skill groups by name, creating groups as needed. */
export function mergeSkills(r: Resume, suggestions: Resume["skills"]) {
  for (const s of suggestions) {
    const existing = r.skills.find((x) => x.name.toLowerCase() === s.name.toLowerCase());
    if (existing) existing.keywords = [...new Set([...(existing.keywords ?? []), ...(s.keywords ?? [])])];
    else r.skills.push({ name: s.name, keywords: s.keywords });
  }
}
