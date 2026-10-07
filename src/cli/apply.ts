import type { CommandContext } from "./context.ts";
import { getAI } from "../ai/index.ts";
import { prepForApplication } from "../ai/prep.ts";
import { addDays, followUpsDue, learn, listApplications, loadApplication, saveApplicationRecord, setStatus, STATUSES, type Status } from "../applications.ts";
import { extractJob, generateTailored, jobCoverage, researchCompany, saveApplication, tailorVariant } from "../job.ts";
import { load } from "../store.ts";
import { loadVariant, saveVariant, variantSlug } from "../variants.ts";
import { print } from "./output.ts";

// Applying for jobs: tailoring, the application tracker, interview prep.

export async function cmdTailor({ command, values, positionals, env }: CommandContext): Promise<number> {
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

export async function cmdApps({ command, values, positionals, env }: CommandContext): Promise<number> {
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

export async function cmdPrep({ command, values, positionals, env }: CommandContext): Promise<number> {
  const slug = positionals[0];
  if (!slug) throw new Error("Usage: cv prep <application-slug>");
  const resume = await load();
  const res = await prepForApplication(await getAI(resume), resume, slug);
  res.questions.forEach((q, i) => print(`${i + 1}. ${q.question}${q.gap ? "  ⚠ no evidence yet" : `\n   ← ${q.evidence[0]}`}`));
  print(`\nWrote ${res.file}`);
  return 0;
}
