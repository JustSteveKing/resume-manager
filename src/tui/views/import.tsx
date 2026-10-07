import { useEffect, useState } from "react";
import { backupResume, describeImport, importJsonResume, planMerge, replacement } from "../../importer.ts";
import { Basics } from "../../schema.ts";
import { SECTIONS, sectionByKey } from "../../sections.ts";
import { isSortedRecent, sortRecent } from "../../sort.ts";
import { saveSource } from "../../sources.ts";
import { extractItems, extractObject, type Effort } from "../../tabstack.ts";
import { mergeBasics, mergeItems } from "../flows.ts";
import { Form, type FormField } from "../form.tsx";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane, wrap } from "../ui.tsx";

interface Req {
  source: "web" | "json";
  url?: string;
  target: string;
  effort: Effort;
  save: boolean;
  location?: string;
  mode: "merge" | "replace";
}

const SOURCE: FormField = {
  key: "source",
  label: "Source",
  kind: "choice",
  options: [
    { value: "web", label: "Web page — Tabstack extracts entries" },
    { value: "json", label: "JSON Resume or LinkedIn export — file, URL, gist, registry user" },
  ],
};

const WEB_FIELDS: FormField[] = [
  SOURCE,
  { key: "url", label: "URL", kind: "text", required: true, hint: "Personal site, talks page, author page, GitHub…", validate: (s) => (URL.canParse(s) ? undefined : "Enter a full URL including https://") },
  {
    key: "target",
    label: "Page contains",
    kind: "choice",
    options: [{ value: "basics", label: "Profile / bio" }, ...SECTIONS.map((s) => ({ value: s.key, label: s.label }))],
  },
  {
    key: "effort",
    label: "Fetch effort",
    kind: "choice",
    options: [
      { value: "min", label: "Min — static pages, fastest" },
      { value: "standard", label: "Standard — most sites" },
      { value: "max", label: "Max — JS-heavy apps, 15–60s" },
    ],
  },
  { key: "save", label: "Save as source", kind: "bool", hint: "Re-run it later from Sources to pick up new entries" },
];

const JSON_FIELDS: FormField[] = [
  SOURCE,
  {
    key: "location",
    label: "File or URL",
    kind: "text",
    required: true,
    hint: "./old-resume.json, resume.yaml, a LinkedIn export (.zip or folder), https://…/resume.json, a gist, or a registry username",
  },
  {
    key: "mode",
    label: "Mode",
    kind: "choice",
    options: [
      { value: "merge", label: "Merge — add new entries, fill empty basics, keep yours" },
      { value: "replace", label: "Replace — overwrite everything (backup first)" },
    ],
  },
];

type LogLine = { text: string; fg?: string };

export function ImportView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent }) {
  const store = useStore();
  const [req, setReq] = useState<Req>({ source: "web", target: "publications", effort: "standard", save: true, mode: "merge" });
  const [log, setLog] = useState<LogLine[]>([]);
  const fields = req.source === "json" ? JSON_FIELDS : WEB_FIELDS;

  async function runWeb() {
    if (!req.url) return store.flash("Enter a URL first", "warn");
    const url = req.url;
    const host = new URL(url).hostname;
    if (req.target === "basics") {
      const found = await store.run(`Extracting profile from ${host}`, () => extractObject(url, Basics, req.effort));
      if (!found) return;
      await mergeBasics(store, found);
    } else {
      const section = SECTIONS.find((s) => s.key === req.target)!;
      const res = await store.run(`Extracting ${section.label.toLowerCase()} from ${host}`, () => extractItems(url, section.schema, req.effort));
      if (!res) return;
      setLog((l) => [...l, { text: `${host}: found ${res.valid.length}, ${res.invalid.length} failed validation` }]);
      if (res.valid.length) await mergeItems(store, section, res.valid as Record<string, any>[]);
    }
    if (req.save) {
      store.update((r) => saveSource(r, { url, target: req.target, effort: req.effort, lastRun: new Date().toISOString() }), "save import source");
    }
  }

  async function runJson() {
    if (!req.location) return store.flash("Enter a file, URL or registry username", "warn");
    const location = req.location;
    const report = await store.run(`Reading ${location}`, () => importJsonResume(location));
    if (!report) return;
    const plan = planMerge(store.resume, report.resume);
    const lines = describeImport(report, req.mode === "merge" ? plan : undefined);
    setLog(lines.map((text) => ({ text, fg: /^(Invalid|Not imported)/.test(text) ? C.warn : undefined })));

    if (req.mode === "replace") {
      const name = report.resume.basics.name ?? "this import";
      if (!(await store.confirm(`Replace your whole resume with ${name}? A backup is written first.`))) return;
      const backup = await backupResume(store.resume, store.path);
      const next = replacement(store.resume, report.resume);
      store.update((r) => {
        for (const key of Object.keys(r) as (keyof typeof r)[]) delete r[key];
        Object.assign(r, next);
      }, `replace resume with ${name}`);
      setLog((l) => [...l, { text: `Replaced. Backup: ${backup}`, fg: C.ok }]);
      return store.flash("Resume replaced", "ok");
    }

    if (!plan.add.length && !Object.keys(plan.fillBasics).length) return store.flash("Nothing new to import", "info");
    const picked = plan.add.length
      ? await store.choose(
          `Import ${plan.add.length} new entries`,
          plan.add.map((e, i) => ({
            value: i,
            label: `${sectionByKey(e.section).label}: ${e.label}`,
            hint: e.similar ? `similar to ${e.similar}` : undefined,
            checked: !e.similar,
          })),
          true,
        )
      : [];
    if (picked === null) return;
    const chosen = new Set(picked);
    store.update((r) => {
      plan.add.forEach((e, i) => chosen.has(i) && (r[e.section] as Record<string, any>[]).push(e.item));
      r.basics = { ...r.basics, ...plan.fillBasics };
    }, `import ${chosen.size} entr${chosen.size === 1 ? "y" : "ies"}`);

    // Offer to sort any dated section the import knocked out of order.
    const touched = [...new Set(plan.add.filter((_, i) => chosen.has(i)).map((e) => e.section))].map(sectionByKey).filter((s) => s.dated);
    const after = structuredClone(store.resume);
    plan.add.forEach((e, i) => chosen.has(i) && (after[e.section] as Record<string, any>[]).push(e.item));
    const unsorted = touched.filter((s) => !isSortedRecent(after[s.key] as Record<string, any>[]));
    if (unsorted.length && (await store.confirm(`Sort ${unsorted.map((s) => s.label).join(", ")} newest first?`))) {
      store.update((r) => unsorted.forEach((s) => sortRecent(r[s.key] as Record<string, any>[])), "sort imported sections");
    }
    const filled = Object.keys(plan.fillBasics);
    store.flash(`Imported ${chosen.size} entr${chosen.size === 1 ? "y" : "ies"}${filled.length ? `, filled ${filled.join(", ")}` : ""}`, "ok");
  }

  useEffect(() => {
    const a = props.intent?.action;
    if (a === "json" || a === "web") {
      setReq((r) => ({ ...r, source: a }));
      setLog([]);
    }
  }, [props.intent?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useKeys(props.active, (key) => {
    if (key.name === "r") (req.source === "json" ? runJson : runWeb)();
  });

  const w = props.width - 4;
  const formH = fields.length + 8;
  const intro =
    req.source === "json"
      ? "Import an existing JSON Resume (JSON or YAML). Older schema fields are renamed, loose dates fixed, and every entry validated; anything that can't be imported is listed. Press r."
      : "Fill in the URL and what the page contains, then press r. Extracted entries are checked against the schema, dates normalised, and you choose which to add.";
  const shown = log.length ? log.flatMap((l) => wrap(l.text, w).map((text) => ({ ...l, text }))) : wrap(intro, w).map((text) => ({ text, fg: C.dim }));

  return (
    <Pane title={req.source === "json" ? "Import · JSON Resume" : "Import from web · Tabstack"} active={props.active} width={props.width}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        <Form
          key={req.source}
          fields={fields}
          value={req}
          onChange={(fn) => {
            const next = { ...req };
            fn(next);
            setReq(next);
            if (next.source !== req.source) setLog([]);
          }}
          active={props.active}
          width={w}
          height={formH}
          onBack={props.onBack}
        />
        <box flexDirection="column" flexGrow={1} border={["top"]} borderColor={C.border} overflow="hidden">
          {shown.map((l, i) => (
            <Line key={i} text={fit(l.text, w)} fg={l.fg} />
          ))}
        </box>
        <Hints keys={[["r", req.source === "json" ? "read & import" : "run import"], ["esc", "back"]]} />
      </box>
    </Pane>
  );
}
