import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_FILE, loadConfig, maskKey, updateConfig, type HomeSource } from "./config.ts";
import { describeSpend, monthSpend } from "./costs.ts";
import { CHECK_ICON, runDoctor } from "./doctor.ts";
import { exportResume, PdfRenderer, type Format, type PaperSize, type PdfResult } from "./export/index.ts";
import { THEMES, themeById, type Theme } from "./export/themes.ts";
import { accountLabel, accountsFromResume, type Account } from "./forges/index.ts";
import { saveReport, scanRepos } from "./repos/index.ts";
import { rewrite } from "./ai/coach.ts";
import { getAI } from "./ai/index.ts";
import { prepForApplication } from "./ai/prep.ts";
import { addDays, followUpsDue, learn, listApplications, loadApplication, saveApplicationRecord, setStatus, STATUSES, type Status } from "./applications.ts";
import { cachedRepos, describeEvidence, evidenceMap, STATUS_TEXT } from "./evidence.ts";
import { applySuggestion, loadSuggestions, resolveSuggestion, runInbox } from "./inbox.ts";
import { applyMerge, describeImport, importJsonResume, planMerge, replaceResume } from "./importer.ts";
import { sectionByKey } from "./sections.ts";
import { isDuplicate } from "./sources.ts";
import { extractJob, generateTailored, jobCoverage, researchCompany, saveApplication, tailorVariant } from "./job.ts";
import { suggestSkills } from "./keywords.ts";
import { hasErrors, lint, type Issue } from "./lint.ts";
import type { Resume } from "./schema.ts";
import { refreshSources, sourceLabel } from "./sources.ts";
import { load, save } from "./store.ts";
import { listVariants, loadVariant, saveVariant, variantSlug, type Variant } from "./variants.ts";

export const HELP = `resume-manager

Usage:
  cv                              Interactive TUI (or \`bun start\` inside the repo)
  cv <command> [options]

Setup:
  init [folder]                   Remember where your resume lives, so \`cv\` works from any folder
  where                           Show which folder and files are in use
  doctor [--live] [--tabstack]    Check setup; --live tests keys (free), --tabstack also tests Tabstack (paid call)
  config ai <auto|claude|tabstack>
  config budget <usd|off>         Monthly cap on priced AI calls
  config key <tabstack|anthropic|github|gitlab> <value|off>
  config gitlab-host <url|off>    Self-hosted GitLab (default gitlab.com)
  spend                           AI and Tabstack spend this month

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

AI features (rewrite, prep, interview drafting) use Claude when ANTHROPIC_API_KEY or an
\`ant auth login\` profile is present, otherwise Tabstack. Force one with RESUME_AI=claude|tabstack.
`;

const print = (s = "") => console.log(s);
const ICON = { error: "✖", warn: "▲", info: "·" } as const;

export function printIssues(issues: Issue[]) {
  if (!issues.length) return print("✔ Valid JSON Resume, no issues");
  for (const group of ["schema", "content", "order", "writing", "consistency"] as const) {
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
  if (p.glance) {
    lines.push(`  First glance: ${p.glance.shows.join(", ") || "nothing recognisable"}`);
    p.glance.warnings.forEach((w) => lines.push(`    ▲ ${w}`));
  }
  return lines;
}

export async function runCommand(argv: string[], env?: { home: string; source: HomeSource }): Promise<number> {
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

    case "tailor": {
      const url = positionals[0];
      if (!url || !URL.canParse(url)) throw new Error("Usage: cv tailor <job-url>");
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
      print(`\nNext: cv export --variant ${name} --ats`);
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
      if (added) print(`Added ${added} entr${added === 1 ? "y" : "ies"}. Run "cv validate" to check ordering.`);
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

    case "import": {
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

    case "init": {
      const home = resolve(positionals[0] ?? process.cwd());
      await mkdir(home, { recursive: true });
      await updateConfig((c) => void (c.home = home));
      print(`Your resume folder is ${home}`);
      print(`Saved in ${CONFIG_FILE}. Run \`cv\` from anywhere.`);
      if (!(await Bun.file(`${home}/resume.json`).exists())) print("No resume.json there yet: run `cv` to import or start one.");
      print("\nInstall the command once with: bun link   (inside the resume-manager repo)");
      return 0;
    }

    case "where": {
      const rows: [string, string | undefined][] = [
        ["Folder", env ? `${env.home}  (from ${env.source})` : process.env.RESUME_HOME],
        ["Resume", process.env.RESUME_PATH],
        ["Variants", process.env.RESUME_VARIANTS_DIR],
        ["Applications", process.env.RESUME_APPLICATIONS_DIR],
        ["Exports", process.env.RESUME_OUT_DIR],
        ["Reports", process.env.RESUME_REPORTS_DIR],
        ["Cache", process.env.RESUME_CACHE_DIR],
        ["Config", CONFIG_FILE],
      ];
      rows.forEach(([k, v]) => print(`${k.padEnd(13)} ${v ?? "—"}`));
      return 0;
    }

    case "doctor": {
      const checks = await runDoctor({ live: values.live, liveTabstack: values.tabstack });
      for (const c of checks) {
        print(`${CHECK_ICON[c.status]} ${c.label.padEnd(24)} ${c.detail}`);
        if (c.fix && c.status !== "ok") print(`  ${"".padEnd(24)} → ${c.fix}`);
      }
      if (!values.live) print("\nRun with --live to test your keys (free checks only).");
      return checks.some((c) => c.status === "error") ? 1 : 0;
    }

    case "config": {
      const [what, a, b] = positionals;
      if (what === "ai") {
        if (!["auto", "claude", "tabstack"].includes(a ?? "")) throw new Error("Usage: cv config ai <auto|claude|tabstack>");
        await updateConfig((c) => void (c.ai = a as "auto"));
        print(`AI: ${a}`);
      } else if (what === "budget") {
        if (a === "off") await updateConfig((c) => void delete c.budget);
        else if (a && Number(a) > 0) await updateConfig((c) => void (c.budget = { monthlyUsd: Number(a) }));
        else throw new Error("Usage: cv config budget <usd|off>");
        print(a === "off" ? "Budget removed" : `Monthly budget: $${Number(a).toFixed(2)}`);
      } else if (what === "key") {
        if (!["tabstack", "anthropic", "github", "gitlab"].includes(a ?? "") || !b) throw new Error("Usage: cv config key <tabstack|anthropic|github|gitlab> <value|off>");
        await updateConfig((c) => {
          c.keys ??= {};
          if (b === "off") delete c.keys[a as "tabstack"];
          else c.keys[a as "tabstack"] = b;
        });
        print(`${a} key: ${b === "off" ? "removed" : maskKey(b)} (stored in ${CONFIG_FILE}, owner-only)`);
      } else if (what === "gitlab-host") {
        if (!a) throw new Error("Usage: cv config gitlab-host <https://gitlab.example.com|off>");
        await updateConfig((c) => {
          if (a === "off") delete c.gitlab;
          else c.gitlab = { host: a };
        });
        print(a === "off" ? "GitLab host: gitlab.com" : `GitLab host: ${a}`);
      } else {
        const c = await loadConfig();
        print(`home     ${c.home ?? "—"}\nai       ${c.ai ?? "auto"}\nbudget   ${c.budget?.monthlyUsd ? `$${c.budget.monthlyUsd}` : "none"}`);
        print(`gitlab   ${c.gitlab?.host ?? "gitlab.com"}`);
        for (const k of ["tabstack", "anthropic", "github", "gitlab"] as const) print(`key      ${k.padEnd(10)} ${maskKey(c.keys?.[k])}`);
      }
      return 0;
    }

    case "spend": {
      print(describeSpend(await monthSpend()));
      return 0;
    }

    case "evidence": {
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

    case "rewrite": {
      const text = positionals.join(" ").trim();
      if (!text) throw new Error('Usage: cv rewrite "<highlight or summary>" [--summary]');
      const ai = await getAI(await load());
      const options = await rewrite(ai, text, values.summary ? "summary" : "highlight");
      if (!options.length) print("No rewrite kept the original facts.");
      options.forEach((o) => print(`${o.label}\n  ${o.text}\n`));
      return 0;
    }

    case "apps": {
      const [sub = "list", slug, arg] = positionals;
      const apps = await listApplications();
      if (sub === "list") {
        if (!apps.length) print("No applications yet. Run `cv tailor <job-url>` to create one.");
        const due = new Set(followUpsDue(apps).map((a) => a.slug));
        for (const a of apps) {
          print(`${due.has(a.slug) ? "⏰ " : "   "}${a.slug.padEnd(36)} ${a.status.padEnd(10)} ${[a.company, a.title].filter(Boolean).join(" — ")}${a.followUp ? ` (follow up ${a.followUp})` : ""}`);
        }
        return 0;
      }
      if (sub === "stats") {
        const l = await learn(apps);
        print(`${l.sent} sent, ${l.responses} got a response`);
        for (const [title, stats] of [["By variant", l.byVariant], ["By theme", l.byTheme], ["By keyword coverage", l.byCoverage]] as const) {
          if (!stats.length) continue;
          print(`\n${title}`);
          stats.forEach((s) => print(`  ${s.key.padEnd(28)} ${s.responses}/${s.sent} (${Math.round(s.rate * 100)}%)`));
        }
        l.insights.forEach((i) => print(`\n→ ${i}`));
        return 0;
      }
      const app = slug ? await loadApplication(slug) : undefined;
      if (!app) throw new Error(`No application "${slug ?? ""}". See \`cv apps\`.`);
      if (sub === "status") {
        if (!STATUSES.includes(arg as Status)) throw new Error(`Status must be one of: ${STATUSES.join(", ")}`);
        const next = await setStatus(app, arg as Status);
        print(`${slug}: ${next.status}${next.followUp ? ` (follow up ${next.followUp})` : ""}`);
        return 0;
      }
      if (sub === "followup") {
        const date = arg?.startsWith("+") ? addDays(new Date().toISOString().slice(0, 10), Number(arg.slice(1)) || 7) : arg;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Usage: apps followup <slug> <YYYY-MM-DD|+N>");
        await saveApplicationRecord({ ...app, followUp: date });
        print(`${slug}: follow up ${date}`);
        return 0;
      }
      throw new Error(`Unknown apps command "${sub}"`);
    }

    case "prep": {
      const slug = positionals[0];
      if (!slug) throw new Error("Usage: cv prep <application-slug>");
      const resume = await load();
      const res = await prepForApplication(await getAI(resume), resume, slug);
      res.questions.forEach((q, i) => print(`${i + 1}. ${q.question}${q.gap ? "  ⚠ no evidence yet" : `\n   ← ${q.evidence[0]}`}`));
      print(`\nWrote ${res.file}`);
      return 0;
    }

    case "inbox": {
      const resume = await load();
      const res = await runInbox(resume, { onProgress: (m) => process.stderr.write(`\r${m.padEnd(70)}`) });
      process.stderr.write("\r".padEnd(72) + "\r");
      res.errors.forEach((e) => print(`▲ ${e}`));
      if (res.baseline) print("First check: GitHub baseline recorded; future runs report new repos and star milestones.");
      const pending = await loadSuggestions();
      if (!pending.length) {
        print("Nothing new.");
        return 0;
      }
      pending.forEach((s) => print(`• ${s.title}\n    ${s.detail}`));
      if (values.yes) {
        for (const s of pending) {
          applySuggestion(resume, s);
          await resolveSuggestion(s.id, false);
        }
        await save(resume);
        print(`\nAccepted ${pending.length}. Run "cv validate" to check ordering.`);
      } else print("\nReview in the TUI (Inbox), or re-run with --yes to accept all.");
      return 0;
    }

    case "scan":
    case "github":
    case "gitlab": {
      const resume = await load();
      const fromProfiles = accountsFromResume(resume);
      const host = values["gitlab-host"] ?? fromProfiles.find((a) => a.forge === "gitlab")?.host;
      let accounts: Account[];
      if (command === "github") {
        const username = positionals[0] ?? fromProfiles.find((a) => a.forge === "github")?.username;
        if (!username) throw new Error("No GitHub profile in resume.json. Usage: cv github <username>");
        accounts = [{ forge: "github", username }];
      } else if (command === "gitlab") {
        const username = positionals[0] ?? fromProfiles.find((a) => a.forge === "gitlab")?.username;
        if (!username) throw new Error("No GitLab profile in resume.json. Usage: cv gitlab <username> [--gitlab-host gitlab.example.com]");
        accounts = [{ forge: "gitlab", username, host }];
      } else {
        accounts = [
          ...(values.github ? [{ forge: "github" as const, username: values.github }] : fromProfiles.filter((a) => a.forge === "github")),
          ...(values.gitlab ? [{ forge: "gitlab" as const, username: values.gitlab, host }] : fromProfiles.filter((a) => a.forge === "gitlab")),
        ];
        if (!accounts.length) throw new Error("No GitHub or GitLab profile in resume.json. Add one in Basics → Profiles, or pass --github/--gitlab.");
      }
      print(`Scanning ${accounts.map(accountLabel).join(" and ")}…`);
      const scan = await scanRepos({
        accounts,
        ai: !values["no-ai"],
        portfolioSize: values.top ? Number(values.top) : undefined,
        refresh: values.refresh,
        onProgress: (m) => process.stderr.write(`\r${m.padEnd(70)}`),
      });
      process.stderr.write("\r".padEnd(72) + "\r");
      const a = scan.analysis;
      const mirrors = scan.data.repos.filter((r) => r.alsoOn?.length).length;
      print(`${a.stats.originals} repos, ${a.stats.stars} stars, ${a.stats.activeLastYear} active in the last year${mirrors ? ` (${mirrors} mirrored on both, counted once)` : ""}`);
      if (scan.summary) print(`\n${scan.summary.summary}`);
      print("\nSkills");
      scan.skills.forEach((g) => print(`  ${g.name}: ${g.keywords!.join(", ")}`));
      print("\nPortfolio");
      for (const { project: p, dropped } of scan.projects) {
        print(`  ${p.name} — ${p.description ?? ""}`);
        p.highlights?.forEach((h) => print(`    - ${h}`));
        if (dropped.length) print(`    (dropped ${dropped.length} claim(s) with numbers not in the facts)`);
      }
      print(`\nReport: ${await saveReport(scan)}`);

      if (values.yes) {
        const projects = sectionByKey("projects");
        const fresh = scan.projects.map((p) => p.project).filter((p) => !isDuplicate(projects, resume.projects, p));
        resume.projects.push(...fresh);
        mergeSkills(resume, scan.skills);
        await save(resume);
        print(`Added ${fresh.length} project(s) and merged ${scan.skills.length} skill group(s) into resume.json`);
      } else print("Re-run with --yes to add the projects and skills, or merge selectively in the TUI (Repositories).");
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
