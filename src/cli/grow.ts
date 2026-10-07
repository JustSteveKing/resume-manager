import type { CommandContext } from "./context.ts";
import { accountLabel, accountsFromResume, type Account } from "../forges/index.ts";
import { saveReport, scanRepos } from "../repos/index.ts";
import { applySuggestion, loadSuggestions, resolveSuggestion, runInbox } from "../inbox.ts";
import { sectionByKey } from "../sections.ts";
import { isDuplicate, refreshSources, sourceLabel } from "../sources.ts";
import { load, save } from "../store.ts";
import { mergeSkills } from "../keywords.ts";
import { print } from "./output.ts";

// Keeping the resume growing: saved sources, the inbox, repository scans.

export async function cmdRefresh({ command, values, positionals, env }: CommandContext): Promise<number> {
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

export async function cmdInbox({ command, values, positionals, env }: CommandContext): Promise<number> {
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

export async function cmdScan({ command, values, positionals, env }: CommandContext): Promise<number> {
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
