import { useEffect, useState } from "react";
import { describePdf } from "../../export/describe.ts";
import { exportResume, OUT_DIR, PdfRenderer, type Format, type PaperSize } from "../../export/index.ts";
import { ACCENTS, THEMES, themeById } from "../../export/themes.ts";
import { loadVariant } from "../../variants.ts";
import { openPath } from "../actions.ts";
import { Form, type FormField } from "../form.tsx";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane } from "../ui.tsx";

interface Settings {
  targets: string[];
  formats: Format[];
  theme: string;
  accent?: string;
  paper: PaperSize;
  pages?: string;
  fit: boolean;
  ats: boolean;
}

const FULL = "@full";

export function ExportView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent }) {
  const store = useStore();
  const last = store.resume.meta?.pdf ?? {};
  const [s, setS] = useState<Settings>({
    targets: [FULL],
    formats: ["pdf"],
    theme: themeById(last.theme)?.id ?? "classic",
    accent: last.accent,
    paper: last.paper ?? "A4",
    fit: true,
    ats: true,
  });
  const [lines, setLines] = useState<{ text: string; fg?: string }[]>([]);
  const [firstPdf, setFirstPdf] = useState<string>();

  const fields: FormField[] = [
    {
      key: "targets",
      label: "Export",
      kind: "multi",
      options: [{ value: FULL, label: "full resume" }, ...store.variants.map((v) => ({ value: v, label: v }))],
    },
    {
      key: "formats",
      label: "Formats",
      kind: "multi",
      options: [
        { value: "pdf", label: "PDF" },
        { value: "html", label: "HTML" },
        { value: "json", label: "JSON Resume" },
        { value: "text", label: "Plain text (ATS forms)" },
        { value: "linkedin", label: "LinkedIn copy (sized to LinkedIn's limits)" },
      ],
    },
    {
      key: "theme",
      label: "Theme",
      kind: "choice",
      hint: "Full resume only; variants use their own theme",
      options: [...THEMES.map((t) => ({ value: t.id, label: `${t.label} — ${t.description}` })), { value: "all", label: "All themes (compare)" }],
    },
    { key: "accent", label: "Accent", kind: "choice", options: [{ value: "", label: "Theme default" }, ...ACCENTS.map((a) => ({ value: a.value, label: `${a.label} ${a.value}` }))] },
    { key: "paper", label: "Paper", kind: "choice", options: [{ value: "A4", label: "A4" }, { value: "Letter", label: "US Letter" }] },
    {
      key: "pages",
      label: "Page target",
      kind: "choice",
      hint: "Overrides each variant's target",
      options: [{ value: "", label: "variant setting / none" }, { value: "1", label: "1 page" }, { value: "2", label: "2 pages" }, { value: "3", label: "3 pages" }],
    },
    { key: "fit", label: "Auto-trim", kind: "bool", hint: "Tighten content until the PDF fits the page target" },
    { key: "ats", label: "ATS check", kind: "bool", hint: "Verify headings, roles and dates survive PDF text extraction" },
  ];

  async function run() {
    if (!s.targets.length || !s.formats.length) return store.flash("Pick at least one target and format", "warn");
    const out: { text: string; fg?: string }[] = [];
    let first: string | undefined;
    const ok = await store.run("Exporting", async (progress) => {
      const renderer = new PdfRenderer();
      try {
        for (const t of s.targets) {
          const full = t === FULL;
          progress(full ? "full resume" : t);
          const res = await exportResume(
            {
              resume: store.resume,
              variant: full ? undefined : await loadVariant(t),
              variantName: full ? undefined : t,
              formats: s.formats,
              themes: full ? (s.theme === "all" ? THEMES : [themeById(s.theme)!]) : undefined,
              accent: full ? s.accent : undefined,
              paper: full ? s.paper : undefined,
              targetPages: s.pages ? Number(s.pages) : undefined,
              fit: s.fit,
              ats: s.ats,
            },
            renderer,
          );
          out.push({ text: full ? "full resume" : t, fg: C.accent });
          res.files.filter((f) => !f.endsWith(".pdf")).forEach((f) => out.push({ text: `  ${f}` }));
          for (const pdf of res.pdfs) {
            first ??= pdf.file;
            describePdf(pdf).forEach((l) => out.push({ text: `  ${l}`, fg: /✖|over target/.test(l) ? C.warn : undefined }));
          }
        }
      } finally {
        await renderer.close();
      }
      return true;
    });
    if (!ok) return;
    if (s.targets.includes(FULL) && s.theme !== "all") {
      store.update((r) => {
        r.meta = { ...r.meta, pdf: { theme: s.theme, accent: s.accent, paper: s.paper } };
      }, "save export settings");
    }
    setLines(out);
    setFirstPdf(first);
    store.flash(`Exported to ${OUT_DIR}/`, "ok");
  }

  useEffect(() => {
    if (props.intent?.action === "run") void run();
  }, [props.intent?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useKeys(props.active, (key) => {
    if (key.name === "r") run();
    else if (key.name === "o" && firstPdf) openPath(firstPdf);
    else if (key.name === "f") openPath(OUT_DIR);
  });

  const w = props.width - 4;
  const formH = Math.min(props.height - 6, fields.length + 9);
  const resultH = props.height - 2 - formH - 1;

  return (
    <Pane title="Export" active={props.active} width={props.width}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        <Form
          fields={fields}
          value={s}
          onChange={(fn) => {
            const next = structuredClone(s);
            fn(next);
            setS(next);
          }}
          active={props.active}
          width={w}
          height={formH}
          onBack={props.onBack}
        />
        <box flexDirection="column" height={resultH} border={["top"]} borderColor={C.border}>
          {!lines.length && <Line text={`Press r to export to ${OUT_DIR}/`} fg={C.dim} />}
          {lines.slice(-resultH).map((l, i) => (
            <Line key={i} text={fit(l.text, w)} fg={l.fg} />
          ))}
        </box>
        <Hints keys={[["r", "run export"], ["o", "open first PDF"], ["f", `open ${OUT_DIR}/`], ["esc", "back"]]} />
      </box>
    </Pane>
  );
}
