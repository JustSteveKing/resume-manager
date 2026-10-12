import { useEffect, useState } from "react";
import { OLLAMA_MODEL } from "../../ai/index.ts";
import { CONFIG_FILE, loadConfig, maskKey, updateConfig, type Config } from "../../config.ts";
import { describeSpend, monthSpend, type MonthSpend } from "../../costs.ts";
import { CHECK_ICON, runDoctor, type Check } from "../../doctor.ts";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane, split, windowStart } from "../ui.tsx";

type KeyName = "tabstack" | "anthropic" | "github" | "gitlab";
const ENV: Record<KeyName, string> = { tabstack: "TABSTACK_API_KEY", anthropic: "ANTHROPIC_API_KEY", github: "GITHUB_TOKEN", gitlab: "GITLAB_TOKEN" };
const STATUS_COLOR = { ok: C.ok, warn: C.warn, error: C.err, info: C.dim } as const;

interface Row {
  id: string;
  label: string;
  value: string;
  edit: () => Promise<void>;
}

/** Settings: keys, AI choice, budget, preview, plus the doctor's checks. Saved to ~/.config, never the repo. */
export function SettingsView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent; imageProtocol?: string }) {
  const store = useStore();
  const [config, setConfig] = useState<Config>({});
  const [checks, setChecks] = useState<Check[]>([]);
  const [spend, setSpend] = useState<MonthSpend>();
  const [sel, setSel] = useState(0);

  const refresh = async (live = false, liveTabstack = false) => {
    setConfig(await loadConfig());
    setSpend(await monthSpend());
    const res = await store.run(live ? "Testing connections" : "Checking setup", () => runDoctor({ live, liveTabstack, imageProtocol: props.imageProtocol }));
    if (res) setChecks(res);
  };
  useEffect(() => {
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (fn: (c: Config) => void, message: string) => {
    setConfig(await updateConfig(fn));
    store.flash(message, "ok");
  };

  const keyRow = (k: KeyName, label: string): Row => {
    const fromConfig = config.keys?.[k];
    const env = process.env[ENV[k]];
    const source = env && env !== fromConfig ? " (environment)" : fromConfig ? " (settings)" : "";
    return {
      id: `key-${k}`,
      label,
      value: `${maskKey(env ?? fromConfig)}${source}`,
      edit: async () => {
        const v = await store.prompt(`${label}: paste a key (empty to remove from settings)`, "");
        if (v === null) return;
        await save((c) => {
          c.keys ??= {};
          if (v.trim()) c.keys[k] = v.trim();
          else delete c.keys[k];
        }, v.trim() ? `${label} saved (owner-only, in ${CONFIG_FILE})` : `${label} removed from settings`);
        // Use it straight away; no restart needed.
        if (v.trim()) process.env[ENV[k]] = v.trim();
        else if (process.env[ENV[k]] === fromConfig) delete process.env[ENV[k]];
      },
    };
  };

  const rows: Row[] = [
    {
      id: "ai",
      label: "Writing AI",
      value: config.ai ?? "auto (Ollama if running, else Claude, else Tabstack)",
      edit: async () => {
        const v = await store.choose("Which model writes?", [
          { value: "auto" as const, label: "auto: Ollama if running, else Claude, else Tabstack" },
          { value: "ollama" as const, label: "ollama: local model, free and private" },
          { value: "claude" as const, label: "claude" },
          { value: "tabstack" as const, label: "tabstack" },
        ]);
        if (!v?.[0]) return;
        await save((c) => void (c.ai = v[0]), `Writing AI: ${v[0]}`);
        if (v[0] === "auto") delete process.env.RESUME_AI;
        else process.env.RESUME_AI = v[0];
      },
    },
    {
      id: "budget",
      label: "Monthly budget",
      value: config.budget?.monthlyUsd ? `$${config.budget.monthlyUsd.toFixed(2)}` : "none",
      edit: async () => {
        const v = await store.prompt("Monthly cap on priced AI calls in USD (empty for none)", config.budget?.monthlyUsd?.toString() ?? "");
        if (v === null) return;
        const n = Number(v);
        if (v.trim() && !(n > 0)) return store.flash("Enter a positive number", "warn");
        await save((c) => {
          if (v.trim()) c.budget = { monthlyUsd: n };
          else delete c.budget;
        }, v.trim() ? `Budget: $${n.toFixed(2)}/month` : "Budget removed");
      },
    },
    keyRow("tabstack", "Tabstack key"),
    keyRow("anthropic", "Anthropic key"),
    keyRow("github", "GitHub token"),
    keyRow("gitlab", "GitLab token"),
    {
      id: "gitlab-host",
      label: "GitLab host",
      value: config.gitlab?.host ?? process.env.GITLAB_HOST ?? "gitlab.com",
      edit: async () => {
        const v = await store.prompt("GitLab host for self-hosted GitLab (empty for gitlab.com)", config.gitlab?.host ?? "");
        if (v === null) return;
        await save((c) => {
          if (v.trim()) c.gitlab = { host: v.trim() };
          else delete c.gitlab;
        }, `GitLab host: ${v.trim() || "gitlab.com"}`);
        if (v.trim()) process.env.GITLAB_HOST = v.trim();
        else delete process.env.GITLAB_HOST;
      },
    },
    {
      id: "ollama-model",
      label: "Ollama model",
      value: config.ollama?.model ?? process.env.OLLAMA_MODEL ?? OLLAMA_MODEL,
      edit: async () => {
        const v = await store.prompt(`Local model for writing (empty for ${OLLAMA_MODEL}); pull it with \`ollama pull\``, config.ollama?.model ?? "");
        if (v === null) return;
        await save((c) => {
          c.ollama ??= {};
          if (v.trim()) c.ollama.model = v.trim();
          else delete c.ollama.model;
        }, `Ollama model: ${v.trim() || OLLAMA_MODEL}`);
        if (v.trim()) process.env.OLLAMA_MODEL = v.trim();
        else delete process.env.OLLAMA_MODEL;
      },
    },
    {
      id: "ollama-host",
      label: "Ollama host",
      value: config.ollama?.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434",
      edit: async () => {
        const v = await store.prompt("Ollama server (empty for http://localhost:11434)", config.ollama?.host ?? "");
        if (v === null) return;
        await save((c) => {
          c.ollama ??= {};
          if (v.trim()) c.ollama.host = v.trim();
          else delete c.ollama.host;
        }, `Ollama host: ${v.trim() || "http://localhost:11434"}`);
        if (v.trim()) process.env.OLLAMA_HOST = v.trim();
        else delete process.env.OLLAMA_HOST;
      },
    },
    {
      id: "preview",
      label: "Preview images",
      value: config.preview?.protocol ?? `auto${props.imageProtocol ? ` (${props.imageProtocol})` : ""}`,
      edit: async () => {
        const v = await store.choose("How to draw PDF pages", [
          { value: "auto" as const, label: "auto: best this terminal supports" },
          { value: "kitty" as const, label: "kitty: Kitty, Ghostty, WezTerm" },
          { value: "sixel" as const, label: "sixel: iTerm2, foot, mlterm…" },
          { value: "blocks" as const, label: "blocks: works everywhere, low resolution" },
        ]);
        if (v?.[0]) await save((c) => void (c.preview = { protocol: v[0] }), `Preview: ${v[0]}`);
      },
    },
  ];
  const current = rows[Math.min(sel, rows.length - 1)];

  useKeys(props.active, async (key) => {
    if (key.name === "up" || key.name === "k") setSel((s) => Math.max(0, s - 1));
    else if (key.name === "down" || key.name === "j") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (key.name === "return" || key.name === "e") await current?.edit();
    else if (key.name === "r") await refresh(true);
    else if (key.name === "T" || (key.shift && key.name === "t")) {
      if (await store.confirm("Testing Tabstack uses one paid Extract call. Continue?")) await refresh(true, true);
    } else if (key.name === "escape" || key.name === "left") props.onBack();
  });

  const w = props.width - 4;
  const checksH = Math.max(3, props.height - rows.length - 9);
  const start = windowStart(0, checks.length, checksH);

  return (
    <Pane title="Settings" active={props.active} width={props.width} footer={CONFIG_FILE}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        {rows.map((r, i) => (
          <Line key={r.id} text={split(`${r.label.padEnd(16)} ${r.value}`, "", w)} bg={i === sel ? (props.active ? C.sel : C.selDim) : undefined} />
        ))}
        <box height={1} />
        {spend && <Line text={fit(`Spend: ${describeSpend(spend)}`, w)} fg={spend.budget && spend.usd > spend.budget * 0.8 ? C.warn : C.dim} />}
        <box flexDirection="column" height={checksH + 1} border={["top"]} borderColor={C.border}>
          {checks.slice(start, start + checksH).map((c) => (
            <Line key={c.id} text={fit(`${CHECK_ICON[c.status]} ${c.label.padEnd(24)} ${c.detail}${c.fix && c.status !== "ok" ? `  → ${c.fix}` : ""}`, w)} fg={STATUS_COLOR[c.status]} />
          ))}
        </box>
        <Hints keys={[["enter", "change"], ["r", "test connections (free)"], ["T", "test Tabstack (paid)"], ["esc", "back"]]} />
      </box>
    </Pane>
  );
}
