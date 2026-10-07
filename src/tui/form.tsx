import type { TextareaRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { useKeys, useStore } from "./store.tsx";
import { C, fit, Hints, Line, windowStart, wrap } from "./ui.tsx";

export type FormKind = "text" | "multiline" | "date" | "list" | "tags" | "number" | "bool" | "choice" | "multi";

export interface FormField {
  key: string;
  label: string;
  kind: FormKind;
  required?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  /** For nested values, e.g. basics.location.city. */
  get?: (value: any) => unknown;
  set?: (draft: any, next: unknown) => void;
  /** Extra validation for single-line kinds. Return an error message to reject. */
  validate?: (input: string) => string | undefined;
}

type Mode =
  | null
  | { kind: "input" }
  | { kind: "textarea" }
  | { kind: "list"; sel: number; edit: number | null } // edit: item index being edited, -1 = new item
  | { kind: "picker"; sel: number; chosen: string[] };

const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export const readField = (f: FormField, v: any) => (f.get ? f.get(v) : v?.[f.key]);

function display(f: FormField, raw: unknown): string {
  if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && !raw.length)) return "";
  if (f.kind === "bool") return raw ? "yes" : "no";
  if (f.kind === "list") return `${(raw as string[]).length} · ${(raw as string[])[0]}`;
  if (f.kind === "tags") return (raw as string[]).join(", ");
  if (f.kind === "choice") return f.options?.find((o) => o.value === raw)?.label ?? String(raw);
  if (f.kind === "multi") {
    const vals = raw as string[];
    return vals.length === f.options?.length ? "all" : vals.map((v) => f.options?.find((o) => o.value === v)?.label ?? v).join(", ");
  }
  return String(raw);
}

/** Parse single-line input for a field. Returns [value] or an error string. */
function parse(f: FormField, input: string): [unknown] | string {
  const s = input.trim();
  if (f.required && !s) return `${f.label} is required`;
  const custom = s ? f.validate?.(s) : undefined;
  if (custom) return custom;
  if (f.kind === "date" && s && !DATE.test(s)) return "Use YYYY, YYYY-MM or YYYY-MM-DD";
  if (f.kind === "number") {
    if (!s) return [undefined];
    return /^\d+$/.test(s) ? [Number(s)] : "Enter a whole number";
  }
  if (f.kind === "tags") return [s ? s.split(",").map((t) => t.trim()).filter(Boolean) : undefined];
  return [s || undefined];
}

export interface FormProps {
  fields: FormField[];
  value: Record<string, any>;
  /** Mutate the underlying value. `label` describes the edit for undo. */
  onChange: (fn: (draft: any) => void, label?: string) => void;
  active: boolean;
  width: number;
  height: number;
  onBack?: () => void;
  /** Start editing this field straight away (e.g. after adding an entry). */
  autoEdit?: string;
  /** Writing coach: offer rewrites of a text value (w). Resolves to the replacement, or null to keep it. */
  onRewrite?: (field: FormField, text: string) => Promise<string | null>;
}

export function Form({ fields, value, onChange, active, width, height, onBack, autoEdit, onRewrite }: FormProps) {
  const store = useStore();
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<Mode>(null);
  const textarea = useRef<TextareaRenderable>(null);
  const field = fields[Math.min(sel, fields.length - 1)]!;
  const raw = readField(field, value);

  useEffect(() => {
    if (!autoEdit) return;
    const i = fields.findIndex((f) => f.key === autoEdit);
    if (i >= 0) {
      setSel(i);
      begin(fields[i]!);
    }
  }, [autoEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  // While any editor is open, the form owns the keyboard (global keys like q are suspended).
  useEffect(() => {
    store.setEditing(mode !== null);
    return () => store.setEditing(false);
  }, [mode !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (f: FormField, next: unknown) =>
    onChange(
      (d) => {
        if (f.set) f.set(d, next);
        else if (next === undefined) delete d[f.key];
        else d[f.key] = next;
      },
      next === undefined ? `clear ${f.label}` : `edit ${f.label}`,
    );

  function begin(f: FormField) {
    const current = readField(f, value);
    if (f.kind === "bool") return set(f, !current);
    if (f.kind === "list") return setMode({ kind: "list", sel: 0, edit: null });
    if (f.kind === "multiline") return setMode({ kind: "textarea" });
    if (f.kind === "choice" || f.kind === "multi") {
      const opts = f.options ?? [];
      const chosen = f.kind === "multi" ? ((current as string[] | undefined) ?? opts.map((o) => o.value)) : [];
      const at = Math.max(0, opts.findIndex((o) => o.value === current));
      return setMode({ kind: "picker", sel: at, chosen });
    }
    setMode({ kind: "input" });
  }

  function commitInput(input: string) {
    const parsed = parse(field, input);
    if (typeof parsed === "string") return store.flash(parsed, "warn");
    set(field, parsed[0]);
    setMode(null);
  }

  function commitTextarea() {
    const text = textarea.current?.plainText.trim() ?? "";
    if (field.required && !text) return store.flash(`${field.label} is required`, "warn");
    set(field, text || undefined);
    setMode(null);
  }

  const items = field.kind === "list" ? ((raw as string[] | undefined) ?? []) : [];
  const setItems = (next: string[]) => set(field, next.length ? next : undefined);

  useKeys(
    active,
    (key) => {
      const up = key.name === "up" || (!mode && key.name === "k");
      const down = key.name === "down" || (!mode && key.name === "j");

      if (!mode) {
        if (up) setSel((s) => Math.max(0, s - 1));
        else if (down) setSel((s) => Math.min(fields.length - 1, s + 1));
        else if (key.name === "return" || key.name === "e" || key.name === "right") begin(field);
        else if (key.name === "space" && field.kind === "bool") begin(field);
        else if ((key.name === "x" || key.name === "delete") && !field.required) set(field, undefined);
        else if (key.name === "w" && onRewrite && (field.kind === "text" || field.kind === "multiline") && typeof raw === "string" && raw.trim()) {
          void onRewrite(field, raw).then((next) => next && set(field, next));
        }
        else if (key.name === "escape" || key.name === "left") onBack?.();
        return;
      }

      if (mode.kind === "input") {
        if (key.name === "escape") setMode(null);
        return; // the <input> handles typing and Enter
      }

      if (mode.kind === "textarea") {
        if (key.name === "escape") setMode(null);
        if (key.ctrl && key.name === "s") commitTextarea();
        return;
      }

      if (mode.kind === "picker") {
        const opts = field.options ?? [];
        if (key.name === "escape") return setMode(null);
        if (up) return setMode({ ...mode, sel: Math.max(0, mode.sel - 1) });
        if (down) return setMode({ ...mode, sel: Math.min(opts.length - 1, mode.sel + 1) });
        const opt = opts[mode.sel];
        if (!opt) return;
        if (field.kind === "multi" && key.name === "space") {
          const chosen = mode.chosen.includes(opt.value) ? mode.chosen.filter((v) => v !== opt.value) : [...mode.chosen, opt.value];
          return setMode({ ...mode, chosen });
        }
        if (key.name === "return") {
          if (field.kind === "choice") set(field, opt.value || undefined);
          else set(field, opts.filter((o) => mode.chosen.includes(o.value)).map((o) => o.value));
          setMode(null);
        }
        return;
      }

      // list editor
      if (mode.edit !== null) {
        if (key.name === "escape") setMode({ ...mode, edit: null });
        return;
      }
      if (key.name === "escape" || key.name === "left") return setMode(null);
      if (key.shift && (key.name === "up" || key.name === "k") && mode.sel > 0) {
        const next = [...items];
        [next[mode.sel - 1], next[mode.sel]] = [next[mode.sel]!, next[mode.sel - 1]!];
        setItems(next);
        return setMode({ ...mode, sel: mode.sel - 1 });
      }
      if (key.shift && (key.name === "down" || key.name === "j") && mode.sel < items.length - 1) {
        const next = [...items];
        [next[mode.sel + 1], next[mode.sel]] = [next[mode.sel]!, next[mode.sel + 1]!];
        setItems(next);
        return setMode({ ...mode, sel: mode.sel + 1 });
      }
      if (up) return setMode({ ...mode, sel: Math.max(0, mode.sel - 1) });
      if (down) return setMode({ ...mode, sel: Math.min(Math.max(0, items.length - 1), mode.sel + 1) });
      if (key.name === "a" || key.name === "o") return setMode({ ...mode, edit: -1 });
      if (key.name === "w" && onRewrite && items[mode.sel]) {
        const at = mode.sel;
        void onRewrite(field, items[at]!).then((next) => {
          if (!next) return;
          const copy = [...items];
          copy[at] = next;
          setItems(copy);
        });
        return;
      }
      if ((key.name === "return" || key.name === "e") && items.length) return setMode({ ...mode, edit: mode.sel });
      if ((key.name === "d" || key.name === "delete") && items.length) {
        setItems(items.filter((_, i) => i !== mode.sel));
        return setMode({ ...mode, sel: Math.max(0, Math.min(mode.sel, items.length - 2)) });
      }
    },
    true,
  );

  // ----- layout -----
  const labelW = Math.min(18, Math.max(...fields.map((f) => f.label.length + (f.required ? 2 : 0))) + 2);
  const valueW = Math.max(4, width - labelW - 1);
  const detailH = Math.max(4, Math.min(12, Math.floor(height / 2)));
  const rowsH = Math.max(1, Math.min(fields.length, height - detailH - 1));
  const start = windowStart(sel, fields.length, rowsH);

  return (
    <box flexDirection="column" width={width} height={height}>
      <box flexDirection="column" height={rowsH}>
        {fields.slice(start, start + rowsH).map((f, j) => {
          const i = start + j;
          const selected = i === sel;
          const v = display(f, readField(f, value));
          const editingHere = selected && mode?.kind === "input";
          return (
            <box key={f.key} flexDirection="row" height={1} backgroundColor={selected ? (active ? C.sel : C.selDim) : undefined}>
              <text wrapMode="none" fg={selected ? C.accent : C.dim} width={labelW}>
                {fit(`${f.label}${f.required ? " *" : ""}`, labelW)}
              </text>
              {editingHere ? (
                <input
                  focused
                  value={raw === undefined ? "" : f.kind === "tags" ? ((raw as string[]) ?? []).join(", ") : String(raw)}
                  width={valueW}
                  backgroundColor={C.panel}
                  focusedBackgroundColor={C.panel}
                  textColor={C.text}
                  placeholder={f.kind === "date" ? "YYYY-MM" : (f.hint ?? "")}
                  onSubmit={(s) => commitInput(String(s))}
                />
              ) : (
                <text wrapMode="none" fg={v ? C.text : C.dim} width={valueW}>
                  {fit(v || "—", valueW)}
                </text>
              )}
            </box>
          );
        })}
      </box>
      <box height={1} />
      <Detail
        canRewrite={!!onRewrite}
        field={field}
        raw={raw}
        mode={mode}
        width={width}
        height={height - rowsH - 1}
        textareaRef={textarea}
        onTextareaSubmit={commitTextarea}
        onListCommit={(input) => {
          if (mode?.kind !== "list" || mode.edit === null) return;
          const s = input.trim();
          const next = [...items];
          if (mode.edit === -1) {
            if (s) next.push(s);
            setItems(next);
            setMode({ ...mode, edit: null, sel: Math.max(0, next.length - 1) });
          } else {
            if (s) next[mode.edit] = s;
            else next.splice(mode.edit, 1);
            setItems(next);
            setMode({ ...mode, edit: null });
          }
        }}
      />
    </box>
  );
}

function Detail(props: {
  canRewrite?: boolean;
  field: FormField;
  raw: unknown;
  mode: Mode;
  width: number;
  height: number;
  textareaRef: React.RefObject<TextareaRenderable | null>;
  onTextareaSubmit: () => void;
  onListCommit: (input: string) => void;
}) {
  const { field, raw, mode, width, height } = props;
  const bodyH = Math.max(1, height - 2);

  if (mode?.kind === "textarea") {
    return (
      <box flexDirection="column" height={height}>
        <box border borderStyle="rounded" borderColor={C.borderActive} height={Math.max(3, height - 1)}>
          <textarea
            ref={props.textareaRef}
            focused
            initialValue={typeof raw === "string" ? raw : ""}
            wrapMode="word"
            backgroundColor={C.panel}
            focusedBackgroundColor={C.panel}
            textColor={C.text}
            keyBindings={[{ name: "s", ctrl: true, action: "submit" }]}
            onSubmit={props.onTextareaSubmit}
          />
        </box>
        <Hints keys={[["ctrl+s", "save"], ["esc", "cancel"]]} />
      </box>
    );
  }

  if (mode?.kind === "picker") {
    const opts = field.options ?? [];
    const start = windowStart(mode.sel, opts.length, bodyH);
    return (
      <box flexDirection="column" height={height}>
        {opts.slice(start, start + bodyH).map((o, j) => {
          const i = start + j;
          const mark = field.kind === "multi" ? (mode.chosen.includes(o.value) ? "[x] " : "[ ] ") : "";
          return <Line key={o.value || "∅"} text={fit(`${mark}${o.label}`, width)} bg={i === mode.sel ? C.sel : undefined} />;
        })}
        <box flexGrow={1} />
        <Hints keys={field.kind === "multi" ? [["space", "toggle"], ["enter", "done"], ["esc", "cancel"]] : [["enter", "choose"], ["esc", "cancel"]]} />
      </box>
    );
  }

  if (mode?.kind === "list") {
    const items = (raw as string[] | undefined) ?? [];
    const rows = mode.edit === -1 ? [...items, ""] : items;
    const sel = mode.edit === -1 ? rows.length - 1 : mode.sel;
    const start = windowStart(sel, rows.length, bodyH);
    return (
      <box flexDirection="column" height={height}>
        {!rows.length && <Line text="No items. Press a to add one." fg={C.dim} />}
        {rows.slice(start, start + bodyH).map((item, j) => {
          const i = start + j;
          const editingThis = mode.edit !== null && (mode.edit === i || (mode.edit === -1 && i === rows.length - 1));
          return editingThis ? (
            <input
              key={`edit-${i}`}
              focused
              value={item}
              width={width}
              backgroundColor={C.panel}
              focusedBackgroundColor={C.panel}
              textColor={C.text}
              onSubmit={(s) => props.onListCommit(String(s))}
            />
          ) : (
            <Line key={`${i}-${item}`} text={fit(`${String(i + 1).padStart(2)}. ${item}`, width)} bg={i === sel ? C.sel : undefined} />
          );
        })}
        <box flexGrow={1} />
        <Hints
          keys={
            mode.edit !== null
              ? [["enter", "save"], ["esc", "cancel"]]
              : [["a", "add"], ["enter", "edit"], ...(props.canRewrite ? ([["w", "rewrite"]] as [string, string][]) : []), ["d", "delete"], ["⇧↑↓", "move"], ["esc", "done"]]
          }
        />
      </box>
    );
  }

  // Read-only view of the selected field's full value.
  const text =
    raw === undefined || raw === ""
      ? ""
      : field.kind === "list"
        ? (raw as string[]).map((s, i) => `${i + 1}. ${s}`).join("\n")
        : display(field, raw);
  const lines = text ? wrap(text, width).slice(0, bodyH) : [];
  return (
    <box flexDirection="column" height={height}>
      <Line text={fit(field.hint ? `${field.label} — ${field.hint}` : field.label, width)} fg={C.dim} />
      {lines.map((l, i) => (
        <Line key={i} text={l} />
      ))}
      <box flexGrow={1} />
      <Hints
        keys={[
          ["↑↓", "field"],
          ["enter", field.kind === "bool" ? "toggle" : "edit"],
          ...(props.canRewrite && (field.kind === "text" || field.kind === "multiline") && raw ? ([["w", "rewrite"]] as [string, string][]) : []),
          ...(field.required ? [] : ([["x", "clear"]] as [string, string][])),
          ["esc", "back"],
        ]}
      />
    </box>
  );
}
