import type { CommandContext } from "./context.ts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeOllamaHost, OLLAMA_MODEL } from "../ai/index.ts";
import { CONFIG_FILE, loadConfig, maskKey, updateConfig } from "../config.ts";
import { describeSpend, monthSpend } from "../costs.ts";
import { CHECK_ICON, runDoctor } from "../doctor.ts";
import type { Resume } from "../schema.ts";
import { print } from "./output.ts";

// Setup commands: where your resume lives, keys, budget, and checks.

export async function cmdInit({ command, values, positionals, env }: CommandContext): Promise<number> {
  const home = resolve(positionals[0] ?? process.cwd());
  await mkdir(home, { recursive: true });
  await updateConfig((c) => void (c.home = home));
  print(`Your resume folder is ${home}`);
  print(`Saved in ${CONFIG_FILE}. Run \`cv\` from anywhere.`);
  if (!(await Bun.file(`${home}/resume.json`).exists())) print("No resume.json there yet: run `cv` to import or start one.");
  print("\nInstall the command once with: bun link   (inside the resume-manager repo)");
  return 0;
}

export async function cmdWhere({ command, values, positionals, env }: CommandContext): Promise<number> {
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

export async function cmdDoctor({ command, values, positionals, env }: CommandContext): Promise<number> {
  const checks = await runDoctor({ live: values.live, liveTabstack: values.tabstack });
  for (const c of checks) {
    print(`${CHECK_ICON[c.status]} ${c.label.padEnd(24)} ${c.detail}`);
    if (c.fix && c.status !== "ok") print(`  ${"".padEnd(24)} → ${c.fix}`);
  }
  if (!values.live) print("\nRun with --live to test your keys (free checks only).");
  return checks.some((c) => c.status === "error") ? 1 : 0;
}

export async function cmdConfig({ command, values, positionals, env }: CommandContext): Promise<number> {
  const [what, a, b] = positionals;
  if (what === "ai") {
    if (!["auto", "ollama", "claude", "tabstack"].includes(a ?? "")) throw new Error("Usage: cv config ai <auto|ollama|claude|tabstack>");
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
  } else if (what === "ollama-model" || what === "ollama-host") {
    if (!a) throw new Error(`Usage: cv config ${what} <${what === "ollama-model" ? "model" : "http://host:11434"}|off>`);
    const field = what === "ollama-model" ? "model" : "host";
    await updateConfig((c) => {
      c.ollama ??= {};
      if (a === "off") delete c.ollama[field];
      else c.ollama[field] = a;
    });
    print(`Ollama ${field}: ${a === "off" ? "default" : a}`);
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
    print(`ollama   ${c.ollama?.model ?? OLLAMA_MODEL} at ${normalizeOllamaHost(c.ollama?.host)}`);
    for (const k of ["tabstack", "anthropic", "github", "gitlab"] as const) print(`key      ${k.padEnd(10)} ${maskKey(c.keys?.[k])}`);
  }
  return 0;
}

export async function cmdSpend({ command, values, positionals, env }: CommandContext): Promise<number> {
  print(describeSpend(await monthSpend()));
  return 0;
}
