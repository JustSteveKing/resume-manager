import type { CommandContext } from "./context.ts";
import { exportResume, PdfRenderer, type Format, type PaperSize } from "../export/index.ts";
import { THEMES, themeById, type Theme } from "../export/themes.ts";
import { rewrite } from "../ai/coach.ts";
import { getAI } from "../ai/index.ts";
import { cachedRepos, describeEvidence, evidenceMap, STATUS_TEXT } from "../evidence.ts";
import { applyMerge, describeImport, importJsonResume, planMerge, replaceResume } from "../importer.ts";
import { mergeSkills, suggestSkills } from "../keywords.ts";
import { hasErrors, lint } from "../lint.ts";
import { load, save } from "../store.ts";
import { listVariants, loadVariant, type Variant } from "../variants.ts";
import { describePdf } from "../export/describe.ts";
import { print, printIssues } from "./output.ts";

// Commands that check, export and edit the resume itself.

export async function cmdValidate({ command, values, positionals, env }: CommandContext): Promise<number> {
  const issues = lint(await load());
  printIssues(issues);
  return hasErrors(issues) || (values.strict && issues.some((i) => i.level === "warn")) ? 1 : 0;
}

export async function cmdVariants({ command, values, positionals, env }: CommandContext): Promise<number> {
  const names = await listVariants();
  if (!names.length) print("No variants yet. Create one in the TUI or add variants/<name>.json");
  for (const n of names) {
    const v = await loadVariant(n);
    print(`${n}${v.label ? ` — ${v.label}` : ""}${v.description ? `\n  ${v.description}` : ""}`);
  }
  return 0;
}

export async function cmdExport({ command, values, positionals, env }: CommandContext): Promise<number> {
  const resume = await load();
  const formats = (values.format ?? "pdf").split(",").map((f) => f.trim()) as Format[];
  const bad = formats.filter((f) => !["pdf", "html", "json", "text", "linkedin"].includes(f));
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

export async function cmdSkills({ command, values, positionals, env }: CommandContext): Promise<number> {
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

export async function cmdEvidence({ command, values, positionals, env }: CommandContext): Promise<number> {
  const resume = await load();
  const gh = await cachedRepos(resume);
  const all = evidenceMap(resume, gh);
  const shown = values.all ? all : all.filter((e) => e.status !== "ok" && e.status !== "strong");
  if (!gh) print("(No repository scan cached; run `cv scan --no-ai` to include GitHub/GitLab evidence.)\n");
  for (const status of ["unsupported", "stale", "weak", "unlisted", "ok", "strong"] as const) {
    const group = shown.filter((e) => e.status === status);
    if (!group.length) continue;
    print(`${status.toUpperCase()}: ${STATUS_TEXT[status]}`);
    group.forEach((e) => print(`  ${e.skill.padEnd(32)} ${describeEvidence(e)}`));
    print();
  }
  return 0;
}

export async function cmdRewrite({ command, values, positionals, env }: CommandContext): Promise<number> {
  const text = positionals.join(" ").trim();
  if (!text) throw new Error('Usage: cv rewrite "<highlight or summary>" [--summary]');
  const ai = await getAI(await load());
  const options = await rewrite(ai, text, values.summary ? "summary" : "highlight");
  if (!options.length) print("No rewrite kept the original facts.");
  options.forEach((o) => print(`${o.label}\n  ${o.text}\n`));
  return 0;
}

export async function cmdImport({ command, values, positionals, env }: CommandContext): Promise<number> {
  const input = positionals[0];
  if (!input) throw new Error("Usage: cv import <file|url|registry-username> [--yes] [--replace]");
  const report = await importJsonResume(input);
  const current = await load();
  const plan = planMerge(current, report.resume);
  describeImport(report, values.replace ? undefined : plan).forEach((l) => print(l));
  if (!values.yes) {
    print(values.replace ? "\nDry run. Add --yes to replace resume.json (a backup is written first)." : "\nDry run. Add --yes to merge, or --replace --yes to overwrite.");
    return 0;
  }
  if (values.replace) {
    const backup = await replaceResume(current, report.resume);
    print(`\nReplaced resume.json. Backup: ${backup}`);
  } else {
    applyMerge(current, plan);
    await save(current);
    const added = plan.add.filter((a) => !a.similar).length;
    const skipped = plan.add.length - added;
    print(`\nMerged ${added} entr${added === 1 ? "y" : "ies"} into resume.json${skipped ? `; skipped ${skipped} possible duplicate(s) (choose them in the TUI)` : ""}. Run "cv validate" to check ordering.`);
  }
  return 0;
}
