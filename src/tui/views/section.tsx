import { useEffect, useState } from "react";
import type { Intent } from "../commands.ts";
import { mergeSkills } from "../../commands.ts";
import { formatDate, formatRange } from "../../dates.ts";
import { suggestSkills } from "../../keywords.ts";
import { Profile, type Resume } from "../../schema.ts";
import { fieldsFor, SECTIONS, type Field, type Section } from "../../sections.ts";
import { isSortedRecent, sortRecent } from "../../sort.ts";
import { rewriteFlow } from "../flows.ts";
import { Form, type FormField } from "../form.tsx";
import { useKeys, useStore } from "../store.tsx";
import { C, Hints, Line, Pane, split, windowStart } from "../ui.tsx";

type Item = Record<string, any>;

export interface SectionSpec {
  id: string;
  label: string;
  fields: FormField[];
  title: (i: Item) => string;
  dated: boolean;
  /** Read the list from a resume. With `write`, create it if missing (only inside update()). */
  items: (r: Resume, write?: boolean) => Item[];
  skills?: boolean;
}

export const toFormFields = (fields: Field[]): FormField[] =>
  fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, required: f.required, hint: f.hint }));

const when = (i: Item) => formatRange(i.startDate, i.endDate) || formatDate(i.releaseDate ?? i.date);

export const sectionSpec = (s: Section): SectionSpec => ({
  id: s.key,
  label: s.label,
  fields: toFormFields(s.fields),
  // The list shows dates in their own column, so drop the "(2022-04)" suffix.
  title: (i) => s.title(i).replace(/ \([^)]*\)$/, ""),
  dated: s.dated,
  items: (r) => r[s.key] as Item[],
  skills: s.key === "skills",
});

export const PROFILES: SectionSpec = {
  id: "profiles",
  label: "Profiles",
  fields: toFormFields(fieldsFor(Profile)),
  title: (i) => [i.network, i.username ?? i.url].filter(Boolean).join(": "),
  dated: false,
  items: (r, write) => (write ? (r.basics.profiles ??= []) : (r.basics.profiles ?? [])),
};

export const SPECS: SectionSpec[] = [PROFILES, ...SECTIONS.map(sectionSpec)];

export function SectionView(props: {
  spec: SectionSpec;
  active: boolean;
  width: number;
  height: number;
  onBack: () => void;
  intent?: Intent;
}) {
  const { spec, active, width, height } = props;
  const store = useStore();
  const items = spec.items(store.resume);
  const [sel, setSel] = useState(0);
  const [focus, setFocus] = useState<"list" | "form">("list");
  const [autoEdit, setAutoEdit] = useState<string>();

  useEffect(() => {
    setSel(0);
    setFocus("list");
  }, [spec.id]);
  // Actions requested from elsewhere (palette, Issues). Defined below, run once per intent.
  const [pending, setPending] = useState<Intent>();
  useEffect(() => setPending(props.intent), [props.intent?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = items[Math.min(sel, items.length - 1)];
  const listW = Math.max(24, Math.floor(width * 0.42));
  const formW = width - listW;
  const inner = (w: number) => w - 4;
  const bodyH = height - 3;
  const start = windowStart(sel, items.length, bodyH);

  const mutateItems = (fn: (list: Item[]) => void, label: string) => store.update((r) => fn(spec.items(r, true)), label);
  const name = (i: Item | undefined) => (i ? spec.title(i) || "untitled" : "entry");

  async function suggest() {
    const suggestions = suggestSkills(store.resume);
    if (!suggestions.length) return store.flash("No new skills found in your resume text", "info");
    const picked = await store.choose(
      "Skills mentioned in your resume but not listed",
      suggestions.flatMap((s) => s.keywords!.map((k) => ({ value: `${s.name}\u0000${k}`, label: k, hint: s.name, checked: true }))),
      true,
    );
    if (!picked?.length) return;
    const grouped = new Map<string, string[]>();
    for (const v of picked) {
      const [group, kw] = v.split("\u0000") as [string, string];
      grouped.set(group, [...(grouped.get(group) ?? []), kw]);
    }
    store.update((r) => mergeSkills(r, [...grouped].map(([name, keywords]) => ({ name, keywords }))), `add ${picked.length} suggested skills`);
    store.flash(`Added ${picked.length} skills`, "ok");
  }

  function add() {
    mutateItems((l) => l.push({}), `add ${spec.label} entry`);
    setSel(items.length);
    setAutoEdit(spec.fields.find((f) => f.required)?.key ?? spec.fields[0]?.key);
    setFocus("form");
  }

  useEffect(() => {
    if (!pending) return;
    setPending(undefined);
    if (pending.action === "select" && typeof pending.payload === "number") {
      setSel(pending.payload);
      setFocus("form");
    } else if (pending.action === "add") add();
    else if (pending.action === "sort" && spec.dated) mutateItems((l) => sortRecent(l), `sort ${spec.label}`);
    else if (pending.action === "suggest" && spec.skills) void suggest();
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  useKeys(active && focus === "list", async (key) => {
    const n = items.length;
    if (key.shift && (key.name === "up" || key.name === "k") && sel > 0) {
      mutateItems((l) => l.splice(sel - 1, 0, ...l.splice(sel, 1)), `move ${name(current)}`);
      return setSel(sel - 1);
    }
    if (key.shift && (key.name === "down" || key.name === "j") && sel < n - 1) {
      mutateItems((l) => l.splice(sel + 1, 0, ...l.splice(sel, 1)), `move ${name(current)}`);
      return setSel(sel + 1);
    }
    if (key.name === "up" || key.name === "k") return setSel((s) => Math.max(0, s - 1));
    if (key.name === "down" || key.name === "j") return setSel((s) => Math.min(Math.max(0, n - 1), s + 1));
    if ((key.name === "return" || key.name === "right" || key.name === "e") && current) {
      setAutoEdit(undefined);
      return setFocus("form");
    }
    if (key.name === "escape" || key.name === "left") return props.onBack();
    if (key.name === "a") return add();
    if (key.name === "d" && current) {
      if (!(await store.confirm(`Delete "${spec.title(current) || "untitled"}"?`))) return;
      mutateItems((l) => l.splice(sel, 1), `delete ${name(current)}`);
      return setSel(Math.max(0, Math.min(sel, n - 2)));
    }
    if (key.name === "s" && spec.dated && n > 1) {
      mutateItems((l) => sortRecent(l), `sort ${spec.label}`);
      return store.flash(`${spec.label} sorted newest first`, "ok");
    }
    if (key.name === "g" && spec.skills) return suggest();
  });

  const unsorted = spec.dated && !isSortedRecent(items);
  const hints: [string, string][] = [
    ["a", "add"],
    ["d", "del"],
    ["⇧↑↓", "move"],
    ...(spec.dated ? ([["s", unsorted ? "sort ▲" : "sort"]] as [string, string][]) : []),
    ...(spec.skills ? ([["g", "suggest"]] as [string, string][]) : []),
  ];

  return (
    <box flexDirection="row" width={width} height={height}>
      <Pane title={`${spec.label} (${items.length})`} active={active && focus === "list"} width={listW}>
        <box flexDirection="column" height={bodyH} paddingLeft={1} paddingRight={1}>
          {!items.length && <Line text={spec.skills ? "Empty. Press g to suggest skills, or a to add." : "Empty. Press a to add."} fg={C.dim} />}
          {items.slice(start, start + bodyH).map((item, j) => {
            const i = start + j;
            const selected = i === sel;
            return (
              <Line
                key={i}
                text={split(spec.title(item) || "(untitled)", when(item), inner(listW))}
                bg={selected ? (active && focus === "list" ? C.sel : C.selDim) : undefined}
                fg={selected ? C.text : undefined}
              />
            );
          })}
        </box>
        <box paddingLeft={1}>
          <Hints keys={hints} />
        </box>
      </Pane>
      <Pane title={current ? spec.title(current) || "New entry" : "—"} active={active && focus === "form"} width={formW}>
        <box paddingLeft={1} paddingRight={1}>
          {current ? (
            <Form
              key={`${spec.id}-${sel}`}
              fields={spec.fields}
              value={current}
              onChange={(fn, label) => mutateItems((l) => fn(l[sel]!), `${label ?? "edit"} (${name(current)})`)}
              active={active && focus === "form"}
              width={inner(formW)}
              height={height - 2}
              autoEdit={autoEdit}
              onRewrite={(field, text) =>
                rewriteFlow(store, text, field.key === "summary" || field.key === "description" ? "role-summary" : "highlight", spec.id === "work" ? (current as never) : undefined)
              }
              onBack={() => {
                setAutoEdit(undefined);
                setFocus("list");
              }}
            />
          ) : (
            <Line text="Nothing selected" fg={C.dim} />
          )}
        </box>
      </Pane>
    </box>
  );
}

