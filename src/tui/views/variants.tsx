import { useEffect, useState } from "react";
import { describePdf } from "../../export/describe.ts";
import { BLOCK_IDS } from "../../export/blocks.ts";
import { safeColour } from "../../export/html.ts";
import { exportResume, type PdfResult } from "../../export/index.ts";
import { ACCENTS, THEMES } from "../../export/themes.ts";
import { deleteVariant, loadVariant, saveVariant, Variant, variantSlug } from "../../variants.ts";
import { openPath } from "../actions.ts";
import { Form, type FormField } from "../form.tsx";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane, split, windowStart } from "../ui.tsx";

const BLOCKS = BLOCK_IDS.filter((b) => b !== "contact");

const nested = (key: "label" | "summary", label: string, kind: "text" | "multiline"): FormField => ({
  key: `basics.${key}`,
  label,
  kind,
  get: (v: Variant) => v.basics?.[key],
  set: (v: Variant, x) => {
    v.basics = { ...v.basics, [key]: x as string | undefined };
    if (!v.basics.label && !v.basics.summary) delete v.basics;
  },
});

export const VARIANT_FIELDS: FormField[] = [
  { key: "label", label: "Label", kind: "text" },
  { key: "description", label: "Description", kind: "text" },
  { key: "tags", label: "Include tags", kind: "tags", hint: "Tagged entries need one of these. Untagged entries are always kept" },
  { key: "excludeTags", label: "Exclude tags", kind: "tags" },
  { key: "keywords", label: "Keywords", kind: "tags", hint: "Rank roles, highlights, projects and talks by these" },
  { key: "maxRoles", label: "Max roles", kind: "number", hint: "Extra roles become one-line Earlier Career entries" },
  { key: "maxHighlights", label: "Max highlights", kind: "number", hint: "Per role" },
  { key: "maxProjects", label: "Max projects", kind: "number" },
  { key: "maxPublications", label: "Max talks", kind: "number" },
  { key: "earlierCareerBefore", label: "Condense before", kind: "date", hint: "Roles that ended before this become Earlier Career" },
  { key: "dropRoleSummaries", label: "Hide summaries", kind: "bool", hint: "Hide role summaries when a role has highlights" },
  {
    key: "blocks",
    label: "Sections",
    kind: "multi",
    options: BLOCKS.map((b) => ({ value: b, label: b })),
    get: (v: Variant) => v.blocks ?? BLOCKS,
    set: (v: Variant, x) => {
      const picked = x as string[] | undefined;
      if (!picked || picked.length === BLOCKS.length) delete v.blocks;
      else v.blocks = BLOCKS.filter((b) => picked.includes(b));
    },
  },
  nested("label", "Headline", "text"),
  nested("summary", "Summary", "multiline"),
  { key: "theme", label: "Theme", kind: "choice", options: [{ value: "", label: "default (classic)" }, ...THEMES.map((t) => ({ value: t.id, label: t.label }))] },
  { key: "accent", label: "Accent", kind: "text", hint: `Hex colour, e.g. ${ACCENTS.map((a) => a.value).slice(0, 3).join(", ")}`, validate: (s) => (safeColour(s) ? undefined : "Use #rgb or #rrggbb") },
  { key: "paper", label: "Paper", kind: "choice", options: [{ value: "", label: "default (A4)" }, { value: "A4", label: "A4" }, { value: "Letter", label: "US Letter" }] },
  { key: "targetPages", label: "Target pages", kind: "number" },
  { key: "fit", label: "Auto-trim", kind: "bool", hint: "Tighten limits until the PDF fits target pages" },
];

export function VariantsView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent }) {
  const store = useStore();
  const names = store.variants;
  const [sel, setSel] = useState(0);
  const [focus, setFocus] = useState<"list" | "form">("list");
  const [variant, setVariant] = useState<Variant | null>(null);
  const [result, setResult] = useState<PdfResult | null>(null);
  const name = names[Math.min(sel, names.length - 1)];

  useEffect(() => {
    setResult(null);
    if (!name) return setVariant(null);
    loadVariant(name).then(setVariant, (e) => {
      setVariant(null);
      store.flash(e instanceof Error ? e.message : String(e), "error");
    });
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  async function change(fn: (draft: Variant) => void) {
    if (!variant || !name) return;
    const next = structuredClone(variant);
    fn(next);
    const parsed = Variant.safeParse(next);
    if (!parsed.success) return store.flash(parsed.error.issues[0]?.message ?? "Invalid variant", "warn");
    setVariant(parsed.data);
    await saveVariant(name, parsed.data);
  }

  async function create(from?: Variant) {
    const input = await store.prompt(from ? "Name for the copy" : "New variant name", from && name ? `${name}-copy` : "");
    if (!input) return;
    const slug = variantSlug(input);
    if (names.includes(slug)) return store.flash(`Variant "${slug}" already exists`, "warn");
    await saveVariant(slug, from ?? { label: input, targetPages: 2, fit: true });
    await store.reloadVariants();
    const next = [...names, slug].sort();
    setSel(next.indexOf(slug));
    if (!from) setFocus("form");
  }

  async function preview(open: boolean) {
    if (!variant || !name) return;
    const res = await store.run(`Rendering ${name}`, (progress) =>
      exportResume({ resume: store.resume, variant, variantName: name, formats: ["pdf"], ats: true, progress }),
    );
    const pdf = res?.pdfs[0];
    if (!pdf) return;
    setResult(pdf);
    if (open) openPath(pdf.file);
  }

  useEffect(() => {
    if (props.intent?.action === "new") void create();
  }, [props.intent?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useKeys(props.active && focus === "list", async (key) => {
    if (key.name === "up" || key.name === "k") setSel((s) => Math.max(0, s - 1));
    else if (key.name === "down" || key.name === "j") setSel((s) => Math.min(Math.max(0, names.length - 1), s + 1));
    else if ((key.name === "return" || key.name === "right" || key.name === "e") && variant) setFocus("form");
    else if (key.name === "escape" || key.name === "left") props.onBack();
    else if (key.name === "n" || key.name === "a") create();
    else if (key.name === "c" && variant) create(variant);
    else if (key.name === "p") preview(false);
    else if (key.name === "o") preview(true);
    else if (key.name === "d" && name) {
      if (!(await store.confirm(`Delete variants/${name}.json?`))) return;
      await deleteVariant(name);
      await store.reloadVariants();
      setSel((s) => Math.max(0, s - 1));
    }
  });

  const listW = Math.max(26, Math.floor(props.width * 0.36));
  const formW = props.width - listW;
  const resultLines = result ? describePdf(result) : [];
  const bodyH = props.height - 3 - Math.max(resultLines.length, 1) - 1;
  const start = windowStart(sel, names.length, bodyH);

  return (
    <box flexDirection="row" width={props.width} height={props.height}>
      <Pane title={`Variants (${names.length})`} active={props.active && focus === "list"} width={listW}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
          <box flexDirection="column" height={bodyH}>
            {!names.length && <Line text="No variants. Press n to create one." fg={C.dim} />}
            {names.slice(start, start + bodyH).map((n, j) => {
              const i = start + j;
              return (
                <Line
                  key={n}
                  text={split(n, i === sel && variant?.targetPages ? `${variant.targetPages}p` : "", listW - 4)}
                  bg={i === sel ? (props.active && focus === "list" ? C.sel : C.selDim) : undefined}
                />
              );
            })}
          </box>
          <box flexDirection="column" border={["top"]} borderColor={C.border}>
            {resultLines.length ? (
              resultLines.map((l, i) => <Line key={i} text={fit(l.replace(/^.*\//, ""), listW - 4)} fg={l.includes("✖") || l.includes("over") ? C.warn : C.ok} />)
            ) : (
              <Line text="p preview pages + ATS · o open PDF" fg={C.dim} />
            )}
          </box>
          <Hints keys={[["n", "new"], ["c", "copy"], ["d", "delete"], ["p", "check"], ["o", "open"]]} />
        </box>
      </Pane>
      <Pane title={variant?.label ?? name ?? "—"} active={props.active && focus === "form"} width={formW}>
        <box paddingLeft={1} paddingRight={1}>
          {variant ? (
            <Form
              key={name}
              fields={VARIANT_FIELDS}
              value={variant}
              onChange={change}
              active={props.active && focus === "form"}
              width={formW - 4}
              height={props.height - 2}
              onBack={() => setFocus("list")}
            />
          ) : (
            <Line text="Select or create a variant" fg={C.dim} />
          )}
        </box>
      </Pane>
    </box>
  );
}
