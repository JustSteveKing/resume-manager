import { useRenderer } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { describePdf } from "../../commands.ts";
import { loadConfig } from "../../config.ts";
import { exportResume, type PaperSize } from "../../export/index.ts";
import { renderText } from "../../export/text.ts";
import { ACCENTS, THEMES, themeById } from "../../export/themes.ts";
import { applyVariant, loadVariant, saveVariant, type Variant } from "../../variants.ts";
import { openPath } from "../actions.ts";
import type { Intent } from "../commands.ts";
import { pagePng, renderPreviewPdf } from "../preview-render.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, Hints, Line, Pane, wrap } from "../ui.tsx";

type Protocol = "auto" | "kitty" | "sixel" | "blocks";

/** Preview: the real PDF drawn in the terminal (or the plain text an ATS sees), for the full resume or any variant. */
export function PreviewView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent }) {
  const store = useStore();
  const targets = ["", ...store.variants];
  const [idx, setIdx] = useState(0);
  const [variant, setVariant] = useState<Variant | undefined>();
  const [mode, setMode] = useState<"page" | "text">(process.env.RESUME_PREVIEW === "text" ? "text" : "page");
  const [scroll, setScroll] = useState(0);
  const [report, setReport] = useState("");
  // Look overrides for trying themes/accents without saving.
  const [themeId, setThemeId] = useState<string>();
  const [accent, setAccent] = useState<string | null>();
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [png, setPng] = useState<Uint8Array>();
  const [rendering, setRendering] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>("auto");
  const name = targets[idx % targets.length] ?? "";
  // Kitty/Sixel images need the terminal's pixel size; without it (some SSH, tmux or pty setups)
  // draw blocks rather than nothing.
  const renderer = useRenderer();
  const drawWith: Protocol = protocol === "auto" && !renderer?.resolution ? "blocks" : protocol;

  useEffect(() => {
    loadConfig().then((c) => setProtocol(c.preview?.protocol ?? "auto"), () => {});
  }, []);

  useEffect(() => {
    setScroll(0);
    setReport("");
    setPage(1);
    setThemeId(undefined);
    setAccent(undefined);
    if (!name) return setVariant(undefined);
    loadVariant(name).then(setVariant, (e) => store.flash(String(e), "error"));
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => applyVariant(store.resume, variant), [store.resume, variant]);
  const last = store.resume.meta?.pdf;
  const theme = themeById(themeId ?? (name ? variant?.theme : last?.theme)) ?? THEMES[0]!;
  const effectiveAccent = accent === null ? undefined : (accent ?? (name ? variant?.accent : last?.accent));
  const paper: PaperSize = (name ? variant?.paper : last?.paper) ?? "A4";

  // Re-render shortly after anything changes (edits, variant, theme, accent).
  useEffect(() => {
    if (mode !== "page") return;
    let cancelled = false;
    setRendering(true);
    const t = setTimeout(async () => {
      try {
        const { pdf, pages: n } = await renderPreviewPdf(view, theme, paper, effectiveAccent);
        const p = Math.min(page, n);
        const image = await pagePng(pdf, p);
        if (cancelled) return;
        setPages(n);
        setPng(image);
        if (p !== page) setPage(p);
      } catch (e) {
        if (!cancelled) store.flash(`Preview failed: ${e instanceof Error ? e.message : e}`, "error");
      } finally {
        if (!cancelled) setRendering(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mode, view, theme.id, paper, effectiveAccent, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const w = props.width - 4;
  const bodyH = props.height - 4;
  const lines = useMemo(
    () => (mode === "text" ? renderText(view).split("\n").flatMap((l) => (l ? wrap(l, w) : [""])) : []),
    [mode, view, w],
  );
  const maxScroll = Math.max(0, lines.length - bodyH);

  async function openPdf() {
    const res = await store.run("Rendering PDF", () =>
      exportResume({
        resume: store.resume,
        variant,
        variantName: name || undefined,
        formats: ["pdf"],
        ats: true,
        themes: [theme],
        accent: effectiveAccent,
        paper,
      }),
    );
    const pdf = res?.pdfs[0];
    if (!pdf) return;
    setReport(describePdf(pdf).join("  ").replace(/\s+/g, " "));
    openPath(pdf.file);
  }

  async function saveLook() {
    if (name && variant) {
      const next = { ...variant, theme: theme.id, accent: effectiveAccent };
      await saveVariant(name, next);
      setVariant(next);
      store.flash(`Saved ${theme.label}${effectiveAccent ? ` ${effectiveAccent}` : ""} to variant ${name}`, "ok");
    } else {
      store.update((r) => {
        r.meta = { ...r.meta, pdf: { ...r.meta?.pdf, theme: theme.id, accent: effectiveAccent, paper } };
      }, `set PDF look to ${theme.label}`);
      store.flash(`Saved ${theme.label} as your default look`, "ok");
    }
    setThemeId(undefined);
    setAccent(undefined);
  }

  useEffect(() => {
    if (props.intent?.action === "open") void openPdf();
  }, [props.intent?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useKeys(props.active, (key) => {
    if (key.name === "t") return setMode((m) => (m === "page" ? "text" : "page"));
    if (key.name === "o") return void openPdf();
    if (key.name === "escape" || key.name === "left") return props.onBack();
    if (key.name === "l" || key.name === "right") return setIdx((i) => (i + 1) % targets.length);
    if (key.name === "h") return setIdx((i) => (i - 1 + targets.length) % targets.length);
    if (mode === "page") {
      if (key.name === "]" || key.name === "pagedown" || key.name === "down" || key.name === "j") setPage((p) => Math.min(pages || 1, p + 1));
      else if (key.name === "[" || key.name === "pageup" || key.name === "up" || key.name === "k") setPage((p) => Math.max(1, p - 1));
      else if (key.name === "c") setThemeId(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!.id);
      else if (key.name === "a") {
        const list = [undefined, ...ACCENTS.map((x) => x.value)];
        const at = list.indexOf(effectiveAccent);
        const next = list[(at + 1) % list.length];
        setAccent(next ?? null);
      } else if (key.name === "s") void saveLook();
      return;
    }
    if (key.name === "down" || key.name === "j") setScroll((s) => Math.min(maxScroll, s + 1));
    else if (key.name === "up" || key.name === "k") setScroll((s) => Math.max(0, s - 1));
    else if (key.name === "pagedown" || key.name === "space") setScroll((s) => Math.min(maxScroll, s + bodyH));
    else if (key.name === "pageup") setScroll((s) => Math.max(0, s - bodyH));
  });

  const tabs = targets.map((t, i) => (i === idx % targets.length ? `[${t || "full resume"}]` : ` ${t || "full resume"} `)).join(" ");
  const lookChanged = themeId !== undefined || accent !== undefined;
  const look = `${theme.label}${effectiveAccent ? ` ${effectiveAccent}` : ""} · ${paper}${lookChanged ? " · unsaved (s to keep)" : ""}`;
  const footer = mode === "page" ? `page ${pages ? page : "–"}/${pages || "–"}` : `${Math.min(scroll + bodyH, lines.length)}/${lines.length}`;

  return (
    <Pane title={`Preview  ${tabs}`} active={props.active} width={props.width} footer={footer}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        {mode === "page" ? (
          <box height={bodyH} width={w} alignItems="center">
            {png ? (
              <image
                key={drawWith}
                source={png}
                fit="fit"
                width={w}
                height={bodyH}
                protocol={drawWith}
                onError={(e) => store.flash(`Couldn't draw the page: ${e instanceof Error ? e.message : e}`, "error")}
              />
            ) : (
              <Line text={rendering ? "Rendering…" : "No preview yet"} fg={C.dim} />
            )}
          </box>
        ) : (
          <box flexDirection="column" height={bodyH}>
            {lines.slice(scroll, scroll + bodyH).map((l, i) => (
              <Line key={scroll + i} text={l} fg={/^[A-Z][A-Z &]+$/.test(l) ? C.accent : /^-+$/.test(l) ? C.border : C.text} />
            ))}
          </box>
        )}
        <Line
          text={report || (mode === "page" ? `${rendering ? "⟳ " : ""}${look}` : "Plain text, as an ATS reads it. Press t for the page view.")}
          fg={report.includes("✖") ? C.warn : lookChanged ? C.info : C.dim}
        />
        <Hints
          keys={
            mode === "page"
              ? [["[ ]", "page"], ["c", "theme"], ["a", "accent"], ["s", "save look"], ["h/l", "variant"], ["t", "text"], ["o", "open PDF"]]
              : [["↑↓/space", "scroll"], ["h/l", "variant"], ["t", "page view"], ["o", "open PDF"]]
          }
        />
      </box>
    </Pane>
  );
}
