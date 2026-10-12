import { useEffect, useState } from "react";
import { mergeSkills } from "../../keywords.ts";
import { accountLabel, accountsFromResume, type Account } from "../../forges/index.ts";
import { saveReport, scanRepos, type ScanResult } from "../../repos/index.ts";
import { sectionByKey } from "../../sections.ts";
import { openPath } from "../actions.ts";
import { mergeItems } from "../flows.ts";
import { Form, type FormField } from "../form.tsx";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane, wrap } from "../ui.tsx";

interface Req {
  username?: string;
  gitlabUser?: string;
  gitlabHost?: string;
  top?: number;
  ai: boolean;
  refresh: boolean;
}

const FIELDS: FormField[] = [
  { key: "username", label: "GitHub user", kind: "text", hint: "From your GitHub profile in Basics → Profiles; clear to skip GitHub" },
  { key: "gitlabUser", label: "GitLab user", kind: "text", hint: "From your GitLab profile; clear to skip GitLab" },
  { key: "gitlabHost", label: "GitLab host", kind: "text", hint: "Blank for gitlab.com, or e.g. gitlab.example.com" },
  { key: "top", label: "Portfolio size", kind: "number", hint: "How many repos to write up (default 8)" },
  { key: "ai", label: "Write-ups (Tabstack)", kind: "bool", hint: "Tabstack generate: skills summary and portfolio copy. Off = facts and rankings only" },
  { key: "refresh", label: "Refresh cache", kind: "bool", hint: "GitHub data is cached for 24 hours" },
];

export function ReposView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent }) {
  const store = useStore();
  const initial = accountsFromResume(store.resume);
  const [req, setReq] = useState<Req>({
    username: initial.find((a) => a.forge === "github")?.username,
    gitlabUser: initial.find((a) => a.forge === "gitlab")?.username,
    gitlabHost: initial.find((a) => a.forge === "gitlab")?.host ?? process.env.GITLAB_HOST,
    ai: true,
    refresh: false,
  });
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [report, setReport] = useState<string>();
  const [scroll, setScroll] = useState(0);

  async function run(override?: Account) {
    const accounts: Account[] = override
      ? [override]
      : [
          ...(req.username ? [{ forge: "github" as const, username: req.username }] : []),
          ...(req.gitlabUser ? [{ forge: "gitlab" as const, username: req.gitlabUser, host: req.gitlabHost || undefined }] : []),
        ];
    if (!accounts.length) return store.flash("Enter a GitHub or GitLab username", "warn");
    const res = await store.run(`Scanning ${accounts.map(accountLabel).join(" and ")}`, (progress) =>
      scanRepos({ accounts, ai: req.ai, portfolioSize: req.top, refresh: req.refresh, onProgress: progress }),
    );
    if (!res) return;
    setScan(res);
    setScroll(0);
    setReport(await saveReport(res));
    store.flash(`Scanned ${res.analysis.stats.originals} repos. Press m to merge into your resume.`, "ok");
  }

  async function merge() {
    if (!scan) return;
    await mergeItems(store, sectionByKey("projects"), scan.projects.map((p) => p.project), "Add GitHub projects");
    const picked = await store.choose(
      "Merge skills",
      scan.skills.flatMap((g) => (g.keywords ?? []).map((k) => ({ value: `${g.name}\u0000${k}`, label: k, hint: g.name, checked: true }))),
      true,
    );
    if (!picked?.length) return;
    const grouped = new Map<string, string[]>();
    for (const v of picked) {
      const [group, kw] = v.split("\u0000") as [string, string];
      grouped.set(group, [...(grouped.get(group) ?? []), kw]);
    }
    store.update((r) => mergeSkills(r, [...grouped].map(([name, keywords]) => ({ name, keywords }))), `merge ${picked.length} GitHub skills`);
    store.flash(`Merged ${picked.length} skills`, "ok");
  }

  useEffect(() => {
    if (props.intent?.action !== "run") return;
    // Welcome passes { forge, username }; the palette just says "run".
    const account = props.intent.payload as Account | undefined;
    if (account?.username) {
      setReq((r) => (account.forge === "github" ? { ...r, username: account.username } : { ...r, gitlabUser: account.username, gitlabHost: account.host }));
      return void run(account);
    }
    if (!req.username && !req.gitlabUser) return store.flash("Enter your GitHub or GitLab username, then press r", "info");
    void run();
  }, [props.intent?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useKeys(props.active, (key) => {
    if (key.name === "r") void run();
    else if (key.name === "m") merge();
    else if (key.name === "o" && report) openPath(report);
    else if (key.name === "pagedown" || key.name === "]") setScroll((s) => s + 5);
    else if (key.name === "pageup" || key.name === "[") setScroll((s) => Math.max(0, s - 5));
  });

  const w = props.width - 4;
  const formH = FIELDS.length + 8;
  const resultH = props.height - 2 - formH - 1;

  const lines: { text: string; fg?: string }[] = [];
  if (scan) {
    const a = scan.analysis;
    const mirrors = scan.data.repos.filter((r) => r.alsoOn?.length).length;
    lines.push({ text: `${scan.accounts.map(accountLabel).join(" + ")} · ${a.stats.originals} repos · ${a.stats.stars} stars · ${a.stats.activeLastYear} active this year${mirrors ? ` · ${mirrors} mirrored` : ""}`, fg: C.accent });
    if (scan.summary) wrap(scan.summary.summary, w).forEach((t) => lines.push({ text: t }));
    lines.push({ text: "" }, { text: "SKILLS", fg: C.accent });
    for (const g of scan.skills) wrap(`${g.name}: ${(g.keywords ?? []).join(", ")}`, w).forEach((t) => lines.push({ text: t }));
    lines.push({ text: "" }, { text: "LANGUAGES", fg: C.accent });
    const top = a.languages[0]?.weight || 1;
    for (const l of a.languages.slice(0, 6)) {
      const bar = "█".repeat(Math.max(1, Math.round((l.weight / top) * 20)));
      lines.push({ text: fit(`${l.name.padEnd(12)} ${bar} ${l.repos} repos · ${l.lastUsed.slice(0, 4)}`, w) });
    }
    lines.push({ text: "" }, { text: "PORTFOLIO", fg: C.accent });
    for (const { project: p, scored, dropped } of scan.projects) {
      lines.push({ text: fit(`${p.name}  (score ${scored.score}: ${scored.reasons.slice(0, 3).join(", ")})`, w), fg: C.text });
      if (p.description) wrap(p.description, w - 2).forEach((t) => lines.push({ text: `  ${t}`, fg: C.dim }));
      p.highlights?.forEach((h) => wrap(`• ${h}`, w - 2).forEach((t) => lines.push({ text: `  ${t}` })));
      if (dropped.length) lines.push({ text: `  dropped ${dropped.length} claim(s): numbers not in the facts`, fg: C.warn });
    }
  } else {
    wrap(
      "Scans your GitHub and GitLab (gitlab.com or self-hosted): languages and frameworks from real dependency manifests (composer.json, package.json, go.mod…), a ranked portfolio with reasons, and optional write-ups (Tabstack generate). Projects mirrored on both count once. Any write-up claim whose numbers aren't in the data is dropped. Press r to scan.",
      w,
    ).forEach((t) => lines.push({ text: t, fg: C.dim }));
  }
  const maxScroll = Math.max(0, lines.length - resultH);
  const at = Math.min(scroll, maxScroll);

  return (
    <Pane title="Repositories · GitHub & GitLab" active={props.active} width={props.width} footer={scan ? `${Math.min(at + resultH, lines.length)}/${lines.length}` : undefined}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        <Form
          fields={FIELDS}
          value={req}
          onChange={(fn) => {
            const next = { ...req };
            fn(next);
            setReq(next);
          }}
          active={props.active}
          width={w}
          height={formH}
          onBack={props.onBack}
        />
        <box flexDirection="column" height={resultH} border={["top"]} borderColor={C.border}>
          {lines.slice(at, at + resultH).map((l, i) => (
            <Line key={at + i} text={l.text} fg={l.fg} />
          ))}
        </box>
        <Hints keys={[["r", "scan"], ["m", "merge into resume"], ["o", "open report"], ["[ ]", "scroll"], ["esc", "back"]]} />
      </box>
    </Pane>
  );
}
