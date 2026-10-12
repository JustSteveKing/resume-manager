import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { runDoctor } from "../doctor.ts";
import { useEffect, useMemo, useState } from "react";
import { lint } from "../lint.ts";
import { load } from "../store.ts";
import { SECTIONS } from "../sections.ts";
import { isSortedRecent, sortRecent } from "../sort.ts";
import type { Command, Intent } from "./commands.ts";
import { ModalView } from "./modal.tsx";
import { Palette } from "./palette.tsx";
import { useStore } from "./store.tsx";
import { C, fit, Hints, Line, levelColor, split, windowStart } from "./ui.tsx";
import { followUpsDue, listApplications } from "../applications.ts";
import { loadSuggestions } from "../inbox.ts";
import { ApplicationsView } from "./views/applications.tsx";
import { BasicsView } from "./views/basics.tsx";
import { CoachView } from "./views/coach.tsx";
import { EvidenceView } from "./views/evidence.tsx";
import { InboxView } from "./views/inbox.tsx";
import { SettingsView } from "./views/settings.tsx";
import { ExportView } from "./views/export.tsx";
import { ReposView } from "./views/repos.tsx";
import { ImportView } from "./views/import.tsx";
import { IssuesView } from "./views/issues.tsx";
import { PreviewView } from "./views/preview.tsx";
import { SectionView, SPECS } from "./views/section.tsx";
import { SourcesView } from "./views/sources.tsx";
import { TailorView } from "./views/tailor.tsx";
import { VariantsView } from "./views/variants.tsx";
import { WelcomeView, type WelcomeChoice } from "./views/welcome.tsx";

type NavRow =
  | { kind: "header"; label: string }
  | { kind: "item"; id: string; label: string; count?: string }
  | { kind: "more"; id: "@more"; label: string };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const NAV_W = 24;
/** Always shown in the nav; the rest only when they have entries (or "more sections" is open). */
const CORE = new Set(["basics", "profiles", "work", "projects", "publications", "skills", "education"]);
const EXAMPLE = new URL("../../examples/resume.example.json", import.meta.url).pathname;

export function App(props: { onQuit: () => void; firstRun?: boolean }) {
  const store = useStore();
  const { width, height } = useTerminalDimensions();
  const [navId, setNavId] = useState(props.firstRun ? "@welcome" : "basics");
  const [focus, setFocus] = useState<"nav" | "main">(props.firstRun ? "main" : "nav");
  const [showAll, setShowAll] = useState(false);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [frame, setFrame] = useState(0);

  const r = store.resume;
  const issues = useMemo(() => lint(r), [r]);
  const warnings = issues.filter((i) => i.level !== "info").length;
  // Counts for Inbox / Applications live on disk; refresh them whenever the view changes.
  const [inboxCount, setInboxCount] = useState(0);
  const [apps, setApps] = useState({ total: 0, due: 0 });
  // What the terminal can draw, from the renderer's capability probe.
  const caps = useRenderer()?.capabilities;
  const imageProtocol = caps?.kitty_graphics ? "kitty" : caps?.sixel ? "sixel" : "blocks";
  // One quiet setup check at startup, so problems show as a badge on Settings.
  const [setupErrors, setSetupErrors] = useState(0);
  useEffect(() => {
    if (process.env.RESUME_SKIP_DOCTOR) return;
    runDoctor({ imageProtocol }).then((c) => setSetupErrors(c.filter((x) => x.status === "error").length), () => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    loadSuggestions().then((s) => setInboxCount(s.length), () => {});
    listApplications().then((a) => setApps({ total: a.length, due: followUpsDue(a).length }), () => {});
  }, [navId]);

  // ----- navigation -----
  type Tool = { id: string; label: string; count?: string };
  const groups: [string, Tool[]][] = [
    [
      "IMPROVE",
      [
        { id: "coach", label: "Coach" },
        { id: "evidence", label: "Evidence" },
        { id: "issues", label: "Issues", count: warnings ? `▲${warnings}` : "✔" },
        { id: "preview", label: "Preview" },
      ],
    ],
    [
      "GROW",
      [
        { id: "inbox", label: "Inbox", count: inboxCount ? String(inboxCount) : undefined },
        { id: "import", label: "Import" },
        { id: "repos", label: "Repositories" },
        { id: "sources", label: "Sources", count: String(r.meta?.sources?.length ?? 0) },
      ],
    ],
    [
      "APPLY",
      [
        { id: "tailor", label: "Tailor to job" },
        { id: "applications", label: "Applications", count: apps.due ? `⏰${apps.due}` : apps.total ? String(apps.total) : undefined },
        { id: "variants", label: "Variants", count: String(store.variants.length) },
        { id: "export", label: "Export" },
      ],
    ],
    ["SETUP", [{ id: "settings", label: "Settings", count: setupErrors ? `✖${setupErrors}` : undefined }]],
  ];
  const tools = groups.flatMap(([, items]) => items);
  const sections = [{ id: "basics", label: "Basics", count: undefined as string | undefined }, ...SPECS.map((s) => ({ id: s.id, label: s.label, count: String(s.items(r).length) }))];
  const shown = sections.filter((s) => showAll || CORE.has(s.id) || s.count !== "0" || s.id === navId);
  const hidden = sections.length - shown.length;
  const rows: NavRow[] = [
    { kind: "header", label: "RESUME" },
    ...shown.map((s) => ({ kind: "item" as const, ...s })),
    ...(hidden || showAll ? [{ kind: "more" as const, id: "@more" as const, label: showAll ? "− fewer sections" : `+ ${hidden} more sections` }] : []),
    ...groups.flatMap(([label, items]) => [{ kind: "header" as const, label }, ...items.map((t) => ({ kind: "item" as const, ...t }))]),
  ];
  const selectable = rows.filter((x): x is Exclude<NavRow, { kind: "header" }> => x.kind !== "header");
  const allLabels = new Map([...sections, ...tools].map((x) => [x.id, x.label]));

  const moveNav = (dir: 1 | -1) => {
    const i = selectable.findIndex((x) => x.id === navId);
    const next = selectable[(i + dir + selectable.length) % selectable.length];
    if (!next) return;
    setNavId(next.id);
    setIntent(null); // an old intent must not re-fire when a view is opened by hand
  };

  /** Open a view, optionally asking it to do something (add an entry, run a scan…). */
  const goTo = (id: string, action?: string, payload?: unknown) => {
    setNavId(id);
    setFocus("main");
    setIntent(action ? { view: id, action, payload, n: Date.now() } : null);
  };

  useEffect(() => {
    if (!store.busy) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, [store.busy]);

  // ----- commands (palette) -----
  const commands: Command[] = [
    ...[...sections, ...tools].map((x) => ({ id: `go:${x.id}`, label: `Go to ${x.label}`, group: "Go to" as const, run: () => goTo(x.id) })),
    ...(store.history.undo ? [{ id: "undo", label: `Undo: ${store.history.undo}`, keys: "u", group: "Edit" as const, run: store.undo }] : []),
    ...(store.history.redo ? [{ id: "redo", label: `Redo: ${store.history.redo}`, keys: "U", group: "Edit" as const, run: store.redo }] : []),
    ...SPECS.map((s) => ({ id: `add:${s.id}`, label: `Add ${s.label} entry`, keywords: "new create", keys: "a", group: "Edit" as const, run: () => goTo(s.id, "add") })),
    {
      id: "sort-all",
      label: "Sort all sections newest first",
      keywords: "order chronological dates",
      group: "Edit",
      run: () => {
        const unsorted = SECTIONS.filter((s) => s.dated && !isSortedRecent(r[s.key] as Record<string, any>[]));
        if (!unsorted.length) return store.flash("Everything is already in order", "info");
        store.update((d) => unsorted.forEach((s) => sortRecent(d[s.key] as Record<string, any>[])), "sort all sections");
        store.flash(`Sorted ${unsorted.map((s) => s.label).join(", ")}`, "ok");
      },
    },
    { id: "skills", label: "Suggest skills from my resume", keywords: "ats keywords", keys: "g", group: "Edit", run: () => goTo("skills", "suggest") },
    { id: "import-json", label: "Import a JSON Resume", keywords: "file yaml gist registry upload", group: "Import", run: () => goTo("import", "json") },
    { id: "import-web", label: "Import from a web page", keywords: "tabstack url talks site", group: "Import", run: () => goTo("import", "web") },
    { id: "scan-repos", label: "Scan my GitHub and GitLab for skills and projects", keywords: "portfolio repos repositories gitlab github", group: "Import", run: () => goTo("repos", "run") },
    { id: "refresh", label: "Refresh saved sources", keywords: "update talks", group: "Import", run: () => goTo("sources", "run") },
    { id: "tailor", label: "Tailor to a job posting", keywords: "cover letter application keywords", group: "Output", run: () => goTo("tailor") },
    { id: "coach", label: "Strengthen a role (achievement interview)", keywords: "coach numbers quantify bullets metrics", group: "Edit", run: () => goTo("coach") },
    { id: "evidence", label: "Check skill evidence", keywords: "proof skills unsupported unlisted", group: "Edit", run: () => goTo("evidence") },
    { id: "inbox", label: "Check for new achievements", keywords: "brag inbox new talks repos milestones", group: "Import", run: () => goTo("inbox", "run") },
    { id: "linkedin-in", label: "Import a LinkedIn data export", keywords: "linkedin zip csv", group: "Import", run: () => goTo("import", "json") },
    { id: "linkedin-out", label: "Export LinkedIn copy", keywords: "linkedin about headline", group: "Output", run: () => goTo("export") },
    { id: "applications", label: "Applications and follow-ups", keywords: "tracker status interview offer prep", group: "Output", run: () => goTo("applications") },
    { id: "export-now", label: "Export now with current settings", keywords: "pdf html json text download", keys: "r", group: "Output", run: () => goTo("export", "run") },
    { id: "export", label: "Export settings…", keywords: "pdf theme accent paper", group: "Output", run: () => goTo("export") },
    { id: "open-pdf", label: "Open the PDF", keywords: "preview view", keys: "o", group: "Output", run: () => goTo("preview", "open") },
    { id: "variant-new", label: "New variant", keywords: "targeted shorter version", group: "Output", run: () => goTo("variants", "new") },
    { id: "issues", label: "Check for problems", keywords: "validate lint issues", group: "Output", run: () => goTo("issues") },
    { id: "welcome", label: "Getting started", keywords: "welcome help onboarding", group: "App", run: () => goTo("@welcome") },
    { id: "sections", label: showAll ? "Hide empty sections" : "Show all sections", keywords: "awards certificates references volunteer interests", group: "App", run: () => setShowAll((v) => !v) },
    { id: "settings", label: "Settings and API keys", keywords: "config ai writing ollama model tabstack github token budget", group: "App", run: () => goTo("settings") },
    { id: "doctor", label: "Check setup (doctor)", keywords: "chrome keys privacy gitignore", group: "App", run: () => goTo("settings") },
    { id: "spend", label: "Tabstack spending this month", keywords: "cost budget usage spend", group: "App", run: () => goTo("settings") },
    { id: "keys", label: "Keyboard shortcuts", keywords: "help", keys: "?", group: "App", run: () => store.setModal({ kind: "help" }) },
    { id: "quit", label: "Quit", keys: "q", group: "App", run: props.onQuit },
  ];

  const welcome: WelcomeChoice[] = [
    { label: "Import an existing JSON Resume", detail: "A file (.json or .yaml), a URL, a GitHub gist, or your registry.jsonresume.org username.", run: () => goTo("import", "json") },
    {
      label: "Start from my GitHub or GitLab",
      detail: "Pull skills from the dependencies your repos actually use, and your best repos as projects. Works with gitlab.com and self-hosted GitLab.",
      run: async () => {
        const forge = await store.choose("Where's your code?", [
          { value: "github" as const, label: "GitHub" },
          { value: "gitlab" as const, label: "GitLab (gitlab.com)" },
          { value: "gitlab-self" as const, label: "Self-hosted GitLab" },
        ]);
        if (!forge?.[0]) return;
        const host = forge[0] === "gitlab-self" ? await store.prompt("GitLab host, e.g. gitlab.example.com") : undefined;
        if (forge[0] === "gitlab-self" && !host) return;
        const username = await store.prompt(`Your ${forge[0] === "github" ? "GitHub" : "GitLab"} username`);
        if (username) goTo("repos", "run", { forge: forge[0] === "github" ? "github" : "gitlab", username, host: host || undefined });
      },
    },
    { label: "Fill in my details", detail: "Start with your name, title and contact details, then add roles one at a time.", run: () => goTo("basics", "edit") },
    {
      label: "Explore with sample data",
      detail: "Load a fictional resume to try everything out. Undo (u) or edit it into your own.",
      run: async () => {
        const sample = await load(EXAMPLE);
        store.update((d) => {
          for (const key of Object.keys(d) as (keyof typeof d)[]) delete d[key];
          Object.assign(d, sample);
        }, "load sample resume");
        goTo("basics");
      },
    },
  ];

  // ----- keys -----
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return props.onQuit();
    if (store.modal) {
      if (store.modal.kind !== "palette") handleModalKey(key);
      return;
    }
    if (key.sequence === ":" || (key.ctrl && key.name === "p")) return store.setModal({ kind: "palette" });
    if (store.editing) return;
    if ((key.name === "u" && !key.shift && !key.ctrl) || (key.ctrl && key.name === "z" && !key.shift)) return store.undo();
    if ((key.name === "u" && key.shift) || (key.ctrl && key.name === "y") || (key.ctrl && key.shift && key.name === "z")) return store.redo();
    if (key.name === "q") return props.onQuit();
    if (key.name === "?") return store.setModal({ kind: "help" });
    if (key.name === "tab") return setFocus((f) => (f === "nav" ? "main" : "nav"));
    if (focus !== "nav") return;
    if (key.name === "up" || key.name === "k") moveNav(-1);
    else if (key.name === "down" || key.name === "j") moveNav(1);
    else if (key.name === "return" || key.name === "right" || key.name === "l") {
      if (navId === "@more") setShowAll((v) => !v);
      else setFocus("main");
    }
  });

  // ----- modal state -----
  const [modalSel, setModalSel] = useState(0);
  const [checked, setChecked] = useState<boolean[]>([]);
  const [promptValue, setPromptValue] = useState("");
  useEffect(() => {
    setModalSel(0);
    if (store.modal?.kind === "choose") setChecked(store.modal.options.map((o) => o.checked ?? false));
    if (store.modal?.kind === "prompt") setPromptValue(store.modal.initial);
  }, [store.modal]);

  const close = () => store.setModal(null);

  function handleModalKey(key: { name: string }) {
    const m = store.modal!;
    if (m.kind === "help") return close();
    if (m.kind === "confirm") {
      if (key.name === "y" || key.name === "return") (close(), m.resolve(true));
      else if (key.name === "n" || key.name === "escape") (close(), m.resolve(false));
      return;
    }
    if (m.kind === "prompt") {
      if (key.name === "escape") (close(), m.resolve(null));
      return; // <input> handles Enter
    }
    if (m.kind === "pick-text") {
      const n = m.options.length;
      if (key.name === "escape") return close(), m.resolve(null);
      if (key.name === "up" || key.name === "k") return setModalSel((s) => Math.max(0, s - 1));
      if (key.name === "down" || key.name === "j") return setModalSel((s) => Math.min(n - 1, s + 1));
      if (/^[1-9]$/.test(key.name) && Number(key.name) <= n) return close(), m.resolve(Number(key.name) - 1);
      if (key.name === "return") return close(), m.resolve(modalSel);
      return;
    }
    if (m.kind !== "choose") return;
    const n = m.options.length;
    if (key.name === "escape") return close(), m.resolve(null);
    if (key.name === "up" || key.name === "k") return setModalSel((s) => Math.max(0, s - 1));
    if (key.name === "down" || key.name === "j") return setModalSel((s) => Math.min(n - 1, s + 1));
    if (m.multi && key.name === "space") return setChecked((c) => c.map((v, i) => (i === modalSel ? !v : v)));
    if (m.multi && key.name === "a") return setChecked((c) => c.map(() => !c.every(Boolean)));
    if (key.name === "return") {
      close();
      m.resolve(m.multi ? m.options.filter((_, i) => checked[i]).map((o) => o.value) : [m.options[modalSel]!.value]);
    }
  }

  // ----- layout -----
  const mainW = Math.max(40, width - NAV_W);
  const mainH = Math.max(10, height - 2);
  const navRows = Math.max(3, mainH - 3);
  const selectedRow = rows.findIndex((x) => x.kind !== "header" && x.id === navId);
  const navStart = windowStart(Math.max(0, selectedRow), rows.length, navRows);
  const main = { active: focus === "main" && !store.modal, width: mainW, height: mainH, onBack: () => setFocus("nav") };
  const mine = (id: string) => (intent?.view === id ? intent : undefined);

  let view;
  const spec = SPECS.find((s) => s.id === navId);
  if (navId === "@welcome") view = <WelcomeView {...main} choices={welcome} onDismiss={() => goTo("basics")} />;
  else if (navId === "basics") view = <BasicsView {...main} intent={mine("basics")} />;
  else if (spec) view = <SectionView key={spec.id} spec={spec} {...main} intent={mine(spec.id)} />;
  else if (navId === "preview") view = <PreviewView {...main} intent={mine("preview")} />;
  else if (navId === "variants") view = <VariantsView {...main} intent={mine("variants")} />;
  else if (navId === "tailor") view = <TailorView {...main} />;
  else if (navId === "import") view = <ImportView {...main} intent={mine("import")} />;
  else if (navId === "repos") view = <ReposView {...main} intent={mine("repos")} />;
  else if (navId === "sources") view = <SourcesView {...main} intent={mine("sources")} />;
  else if (navId === "issues") view = <IssuesView {...main} onJump={(section, index) => goTo(section, "select", index)} />;
  else if (navId === "export") view = <ExportView {...main} intent={mine("export")} />;
  else if (navId === "settings") view = <SettingsView {...main} intent={mine("settings")} imageProtocol={imageProtocol} />;
  else if (navId === "coach") view = <CoachView {...main} intent={mine("coach")} />;
  else if (navId === "evidence") view = <EvidenceView {...main} intent={mine("evidence")} />;
  else if (navId === "applications") view = <ApplicationsView {...main} intent={mine("applications")} />;
  else if (navId === "inbox") view = <InboxView {...main} intent={mine("inbox")} onChange={setInboxCount} />;

  const save = store.saveState;
  const saveText = save.status === "saved" ? "✔ saved" : save.status === "blocked" ? `▲ not saved: ${save.detail}` : `✖ ${save.detail}`;
  const status = store.busy
    ? { text: `${SPINNER[frame]} ${store.busy}`, fg: C.info }
    : store.message
      ? { text: store.message.text, fg: levelColor(store.message.level) }
      : null;

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={C.bg}>
      <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text wrapMode="none" fg={C.accent}>
          <strong>resume-manager</strong>
        </text>
        <text wrapMode="none" fg={C.dim} flexGrow={1}>
          {fit(`  ${r.basics.name ?? ""}  ·  ${store.path}`, Math.max(0, width - 16 - saveText.length - 4))}
        </text>
        <text wrapMode="none" fg={save.status === "saved" ? C.ok : C.warn}>
          {saveText}
        </text>
      </box>
      <box flexDirection="row" height={mainH}>
        <box
          width={NAV_W}
          border
          borderStyle="rounded"
          borderColor={focus === "nav" && !store.modal ? C.borderActive : C.border}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          overflow="hidden"
        >
          {rows.slice(navStart, navStart + navRows).map((row, j) => {
            if (row.kind === "header") return <Line key={`h-${row.label}`} text={row.label} fg={C.dim} />;
            const selected = row.id === navId;
            const count = row.kind === "item" ? (row.count ?? "") : "";
            return (
              <Line
                key={row.id}
                text={split(row.kind === "more" ? row.label : ` ${row.label}`, count, NAV_W - 4)}
                bg={selected ? (focus === "nav" ? C.sel : C.selDim) : undefined}
                fg={row.kind === "more" ? C.dim : row.id === "issues" && warnings ? C.warn : count === "0" ? C.dim : selected ? C.text : undefined}
              />
            );
          })}
          <box flexGrow={1} />
          <Hints keys={[[":", "search"], ["?", "keys"]]} />
        </box>
        {view}
      </box>
      <box height={1} paddingLeft={1} paddingRight={1}>
        {status ? (
          <Line text={fit(status.text, width - 2)} fg={status.fg} />
        ) : (
          <Hints
            keys={[
              [":", "search actions"],
              ["tab", "switch pane"],
              ["enter", "open/edit"],
              ["esc", "back"],
              ...(store.history.undo ? ([["u", `undo ${fit(store.history.undo, 28).trimEnd()}`]] as [string, string][]) : []),
            ]}
          />
        )}
      </box>
      {store.modal?.kind === "palette" && <Palette commands={commands} width={width} height={height} onClose={close} />}
      {store.modal && store.modal.kind !== "palette" && (
        <ModalView
          width={width}
          height={height}
          sel={modalSel}
          checked={checked}
          promptValue={promptValue}
          onPromptSubmit={(v) => {
            const m = store.modal;
            if (m?.kind !== "prompt") return;
            close();
            m.resolve(v.trim() || null);
          }}
        />
      )}
    </box>
  );
}

