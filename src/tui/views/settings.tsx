import { useEffect, useState } from "react";
import { OLLAMA_HOST, OLLAMA_MODEL } from "../../ai/index.ts";
import { CONFIG_FILE, loadConfig, maskKey, updateConfig, type Config } from "../../config.ts";
import { describeSpend, monthSpend, type MonthSpend } from "../../costs.ts";
import { CHECK_ICON, runDoctor, type Check } from "../../doctor.ts";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane, split, windowStart } from "../ui.tsx";

type KeyName = "tabstack" | "github" | "gitlab";
const ENV: Record<KeyName, string> = { tabstack: "TABSTACK_API_KEY", github: "GITHUB_TOKEN", gitlab: "GITLAB_TOKEN" };
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
    try {
      setConfig(await loadConfig());
      setSpend(await monthSpend());
    } catch (e) {
      // The doctor below lists the same problem with a fix.
      store.flash(e instanceof Error ? e.message : String(e), "error");
    }
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

  /** A config value mirrored into an env var. The environment wins at runtime, so show that, and only unset what Settings set. */
  const settingRow = (o: { id: string; label: string; env: string; fallback: string; prompt: string; get: (c: Config) => string | undefined; set: (c: Config, v?: string) => void }): Row => {
    const fromConfig = o.get(config);
    const env = process.env[o.env];
    const source = env && env !== fromConfig ? " (environment)" : "";
    return {
      id: o.id,
      label: o.label,
      value: `${env ?? fromConfig ?? o.fallback}${source}`,
      edit: async () => {
        const v = await store.prompt(o.prompt, fromConfig ?? "");
        if (v === null) return;
        await save((c) => o.set(c, v.trim() || undefined), `${o.label}: ${v.trim() || o.fallback}`);
        if (v.trim()) process.env[o.env] = v.trim();
        else if (process.env[o.env] === fromConfig) delete process.env[o.env];
      },
    };
  };

  const rows: Row[] = [
    {
      id: "ai",
      label: "Writing AI",
      value: config.ai ?? "auto (Ollama)",
      edit: async () => {
        const v = await store.choose("Which model writes?", [
          { value: "auto" as const, label: "auto: Ollama, checking it's running and the model is pulled" },
          { value: "ollama" as const, label: "ollama: local model, free and private" },
          { value: "tabstack" as const, label: "tabstack: Tabstack generate (cloud, needs a key and a website)" },
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
    keyRow("github", "GitHub token"),
    keyRow("gitlab", "GitLab token"),
    settingRow({
      id: "gitlab-host",
      label: "GitLab host",
      env: "GITLAB_HOST",
      fallback: "gitlab.com",
      prompt: "GitLab host for self-hosted GitLab (empty for gitlab.com)",
      get: (c) => c.gitlab?.host,
      set: (c, v) => {
        if (v) c.gitlab = { host: v };
        else delete c.gitlab;
      },
    }),
    settingRow({
      id: "ollama-model",
      label: "Ollama model",
      env: "OLLAMA_MODEL",
      fallback: OLLAMA_MODEL,
      prompt: `Local model for writing (empty for ${OLLAMA_MODEL}); pull it with \`ollama pull\``,
      get: (c) => c.ollama?.model,
      set: (c, v) => {
        c.ollama ??= {};
        if (v) c.ollama.model = v;
        else delete c.ollama.model;
      },
    }),
    settingRow({
      id: "ollama-host",
      label: "Ollama host",
      env: "OLLAMA_HOST",
      fallback: OLLAMA_HOST,
      prompt: `Ollama server (empty for ${OLLAMA_HOST})`,
      get: (c) => c.ollama?.host,
      set: (c, v) => {
        c.ollama ??= {};
        if (v) c.ollama.host = v;
        else delete c.ollama.host;
      },
    }),
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
