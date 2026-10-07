import type { Resume, Skill } from "../schema.ts";
import { analyze, type RepoAnalysis } from "./analyze.ts";
import { accountLabel, accountsFromResume, collectAccount, mergeData, type Account } from "../forges/index.ts";
import type { GitLabClient } from "../forges/gitlab.ts";
import type { GitHubClient } from "../forges/github.ts";
import type { RepoData } from "./types.ts";
import { cachedGenerate, summarizeSkills, toProjects, toSkills, writePortfolio, type Generate, type GroundedProject, type SkillsSummary } from "./summarize.ts";

export const REPORTS_DIR = process.env.RESUME_REPORTS_DIR ?? "reports";

/** Accounts to scan: the resume's GitHub/GitLab profiles unless given explicitly. */
export const scanAccounts = (r: Resume, explicit?: Account[]) => (explicit?.length ? explicit : accountsFromResume(r));

export interface ScanOptions {
  /** GitHub username (shorthand for accounts: [{ forge: "github", username }]). */
  username?: string;
  accounts?: Account[];
  /** Use Tabstack generate for the skills summary and portfolio write-ups. */
  ai?: boolean;
  portfolioSize?: number;
  refresh?: boolean;
  onProgress?: (m: string) => void;
  /** Injected for tests. */
  generate?: Generate;
  client?: GitHubClient;
  gitlabClient?: GitLabClient;
}

export interface ScanResult {
  accounts: Account[];
  data: RepoData;
  analysis: RepoAnalysis;
  summary?: SkillsSummary;
  projects: GroundedProject[];
  skills: Skill[];
}

/** Scan GitHub and/or GitLab accounts, merge them (mirrors counted once), analyse, and optionally write. */
export async function scanRepos(opts: ScanOptions): Promise<ScanResult> {
  const progress = opts.onProgress ?? (() => {});
  const accounts = opts.accounts?.length ? opts.accounts : opts.username ? [{ forge: "github" as const, username: opts.username }] : [];
  if (!accounts.length) throw new Error("No GitHub or GitLab account to scan. Add one to Basics → Profiles, or pass a username.");
  const datas: RepoData[] = [];
  for (const account of accounts) {
    datas.push(
      await collectAccount(account, {
        refresh: opts.refresh,
        onProgress: (m) => progress(accounts.length > 1 ? `${accountLabel(account)}: ${m}` : m),
        detailed: Math.max(16, (opts.portfolioSize ?? 8) * 2),
        githubClient: opts.client,
        gitlabClient: opts.gitlabClient,
      }),
    );
  }
  const data = mergeData(datas);
  const analysis = analyze(data, { portfolioSize: opts.portfolioSize });

  let summary: SkillsSummary | undefined;
  let writeups;
  if (opts.ai) {
    const generate = opts.generate ?? cachedGenerate(opts.refresh);
    progress("summarising skills (Tabstack)");
    summary = await summarizeSkills(analysis, data.user.bio, generate, data.profileUrl);
    writeups = await writePortfolio(analysis, generate, progress, data.profileUrl);
  }
  const repoNames = data.repos.map((r) => r.name);
  return { accounts, data, analysis, summary, projects: toProjects(analysis, writeups), skills: toSkills(analysis, summary, repoNames) };
}


export function scanReport(s: ScanResult): string {
  const a = s.analysis;
  const lines = [
    `# Repositories: ${s.accounts.map(accountLabel).join(" · ")}`,
    "",
    `Collected ${s.data.collectedAt.slice(0, 10)} · ${a.stats.originals} original repos (${a.stats.forks} forks) · ${a.stats.stars} stars · ${a.stats.activeLastYear} active in the last year · ${a.stats.yearsActive} years publishing code`,
    "",
  ];
  if (s.summary) lines.push("## Summary", "", s.summary.summary, "");
  lines.push("## Skills", "");
  for (const g of s.skills) {
    lines.push(`- **${g.name}:** ${g.keywords!.join(", ")}`);
    const evidence = s.summary?.skills.find((x) => x.name === g.name)?.evidence;
    if (evidence) lines.push(`  - ${evidence}`);
  }
  lines.push("", "## Languages", "", "| Language | Repos | Last used |", "| --- | --- | --- |");
  a.languages.slice(0, 10).forEach((l) => lines.push(`| ${l.name} | ${l.repos} | ${l.lastUsed.slice(0, 4)} |`));
  lines.push("", "## Frameworks & tools", "", "| Tool | Repos | Evidence | Last used |", "| --- | --- | --- | --- |");
  a.tools.slice(0, 25).forEach((t) => lines.push(`| ${t.name} | ${t.repos.length} | ${t.source} | ${t.lastUsed.slice(0, 4)} |`));
  lines.push("", "## Portfolio", "");
  for (const { project: p, scored, dropped } of s.projects) {
    lines.push(`### [${p.name}](${p.url})`, "", `Score ${scored.score}: ${scored.reasons.join(", ")}${scored.repo.alsoOn?.length ? ` · also on ${scored.repo.alsoOn.join(", ")}` : ""}`, "", p.description ?? "", "");
    p.highlights?.forEach((h) => lines.push(`- ${h}`));
    if (p.keywords?.length) lines.push("", `Technologies: ${p.keywords.join(", ")}`);
    if (dropped.length) lines.push("", `Dropped (numbers not in the facts): ${dropped.map((d) => `"${d}"`).join("; ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function saveReport(s: ScanResult): Promise<string> {
  const file = `${REPORTS_DIR}/repos-${s.analysis.login.toLowerCase()}.md`;
  await Bun.write(file, scanReport(s) + "\n");
  return file;
}
