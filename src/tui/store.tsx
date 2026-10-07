import { useKeyboard } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getAI, type AI } from "../ai/index.ts";
import type { Resume } from "../schema.ts";
import { SECTIONS } from "../sections.ts";
import { save } from "../store.ts";
import { listVariants } from "../variants.ts";
import type { Level } from "./ui.tsx";

export interface ChoiceOption<T = string> {
  value: T;
  label: string;
  hint?: string;
  checked?: boolean;
}

export type Modal =
  | { kind: "confirm"; text: string; resolve: (ok: boolean) => void }
  | { kind: "prompt"; text: string; initial: string; resolve: (value: string | null) => void }
  | { kind: "choose"; text: string; multi: boolean; options: ChoiceOption<unknown>[]; resolve: (values: unknown[] | null) => void }
  | { kind: "help" }
  | { kind: "palette" }
  | { kind: "pick-text"; text: string; options: { label: string; text: string }[]; resolve: (index: number | null) => void };

interface Store {
  resume: Resume;
  path: string;
  /** Apply a mutation to a copy of the resume, then save it. `label` names it for undo ("delete Acme Corp"). */
  update(fn: (draft: Resume) => void, label?: string): void;
  undo(): void;
  redo(): void;
  /** Labels of what undo / redo would do next. */
  history: { undo?: string; redo?: string };
  saveState: { status: "saved" | "blocked" | "error"; detail?: string };
  message: { text: string; level: Level } | null;
  flash(text: string, level?: Level): void;
  busy: string | null;
  /** Run a background task with a status-bar spinner. Errors are flashed, not thrown. */
  run<T>(label: string, fn: (progress: (m: string) => void) => Promise<T>): Promise<T | undefined>;
  modal: Modal | null;
  setModal(m: Modal | null): void;
  confirm(text: string): Promise<boolean>;
  prompt(text: string, initial?: string): Promise<string | null>;
  choose<T>(text: string, options: ChoiceOption<T>[], multi?: boolean): Promise<T[] | null>;
  /** True while a text editor or picker owns the keyboard. */
  editing: boolean;
  setEditing(v: boolean): void;
  variants: string[];
  reloadVariants(): Promise<void>;
  /** Pick from long text options (shown wrapped in full). Resolves to the chosen index or null. */
  pickText(text: string, options: { label: string; text: string }[]): Promise<number | null>;
  /** The configured writing model, or undefined (with an explanation flashed) if none is set up. */
  getAI(): Promise<AI | undefined>;
  /** Injected in tests. */
  ai?: AI;
}

const Ctx = createContext<Store | null>(null);

export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
};

/**
 * Keyboard handler that only fires when `active` and no modal is open (unless `inModal`, for a modal's own keys).
 * Skips while an editor owns input unless `whileEditing`.
 */
export function useKeys(active: boolean, handler: (key: KeyEvent) => void, whileEditing = false, inModal = false) {
  const { modal, editing } = useStore();
  useKeyboard((key) => {
    if (!active || (modal && !inModal)) return;
    if (editing && !whileEditing) return;
    handler(key);
  });
}

/** Required fields left blank: saving them would write a resume.json that no longer validates. */
export function saveBlockers(r: Resume): string[] {
  const out: string[] = [];
  for (const s of SECTIONS) {
    const required = s.fields.filter((f) => f.required);
    (r[s.key] as Record<string, unknown>[]).forEach((item, i) => {
      for (const f of required) {
        const v = item[f.key];
        if (typeof v !== "string" || !v.trim()) out.push(`${s.label} #${i + 1} needs ${f.label}`);
      }
    });
  }
  return out;
}

export function StoreProvider(props: { initial: Resume; path: string; children: ReactNode; ai?: AI }) {
  const [resume, setResume] = useState(props.initial);
  const ref = useRef(props.initial);
  const [saveState, setSaveState] = useState<Store["saveState"]>({ status: "saved" });
  const [message, setMessage] = useState<Store["message"]>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [editing, setEditing] = useState(false);
  const [variants, setVariants] = useState<string[]>([]);
  const saving = useRef(Promise.resolve());
  // Undo history: snapshots of the whole resume, newest last.
  const past = useRef<{ label: string; resume: Resume }[]>([]);
  const future = useRef<{ label: string; resume: Resume }[]>([]);
  const [history, setHistory] = useState<Store["history"]>({});
  const syncHistory = () => setHistory({ undo: past.current.at(-1)?.label, redo: future.current.at(-1)?.label });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flash = useCallback((text: string, level: Level = "info") => {
    setMessage({ text, level });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), level === "error" ? 8000 : 4000);
  }, []);

  /** Make `next` current and persist it (unless a required field is blank). */
  const commit = useCallback(
    (next: Resume) => {
      ref.current = next;
      setResume(next);
      const blockers = saveBlockers(next);
      if (blockers.length) {
        setSaveState({ status: "blocked", detail: blockers[0] });
        return;
      }
      // Serialise writes so a slow save never lands after a newer one.
      saving.current = saving.current
        .then(() => save(next, props.path))
        .then(() => setSaveState({ status: "saved" }))
        .catch((e) => setSaveState({ status: "error", detail: e instanceof Error ? e.message : String(e) }));
    },
    [props.path],
  );

  const update = useCallback(
    (fn: (draft: Resume) => void, label = "change") => {
      const before = ref.current;
      const next = structuredClone(before);
      fn(next);
      if (JSON.stringify(next) === JSON.stringify(before)) return; // no-op edits don't clutter history
      past.current.push({ label, resume: before });
      if (past.current.length > 200) past.current.shift();
      future.current = [];
      syncHistory();
      commit(next);
    },
    [commit], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const undo = useCallback(() => {
    const entry = past.current.pop();
    if (!entry) return flash("Nothing to undo", "info");
    future.current.push({ label: entry.label, resume: ref.current });
    syncHistory();
    commit(entry.resume);
    flash(`Undid: ${entry.label}`, "ok");
  }, [commit, flash]); // eslint-disable-line react-hooks/exhaustive-deps

  const redo = useCallback(() => {
    const entry = future.current.pop();
    if (!entry) return flash("Nothing to redo", "info");
    past.current.push({ label: entry.label, resume: ref.current });
    syncHistory();
    commit(entry.resume);
    flash(`Redid: ${entry.label}`, "ok");
  }, [commit, flash]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(
    async <T,>(label: string, fn: (progress: (m: string) => void) => Promise<T>) => {
      if (busy) {
        flash(`Busy: ${busy}`, "warn");
        return undefined;
      }
      setBusy(label);
      try {
        return await fn((m) => setBusy(`${label}: ${m}`));
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e), "error");
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [busy, flash],
  );

  const reloadVariants = useCallback(async () => setVariants(await listVariants()), []);
  useEffect(() => {
    reloadVariants();
  }, [reloadVariants]);

  const store = useMemo<Store>(
    () => ({
      resume, path: props.path, update, undo, redo, history, saveState, message, flash, busy, run, modal, setModal, editing, setEditing,
      variants, reloadVariants,
      confirm: (text) => new Promise((resolve) => setModal({ kind: "confirm", text, resolve })),
      prompt: (text, initial = "") => new Promise((resolve) => setModal({ kind: "prompt", text, initial, resolve })),
      pickText: (text, options) => new Promise((resolve) => setModal({ kind: "pick-text", text, options, resolve })),
      ai: props.ai,
      getAI: async () => {
        if (props.ai) return props.ai;
        try {
          return await getAI(ref.current);
        } catch (e) {
          flash(e instanceof Error ? e.message : String(e), "warn");
          return undefined;
        }
      },
      choose: <T,>(text: string, options: ChoiceOption<T>[], multi = false) =>
        new Promise<T[] | null>((resolve) =>
          setModal({ kind: "choose", text, multi, options: options as ChoiceOption<unknown>[], resolve: resolve as (v: unknown[] | null) => void }),
        ),
    }),
    [resume, props.path, update, undo, redo, history, saveState, message, flash, busy, run, modal, editing, variants, reloadVariants, props.ai],
  );

  return <Ctx.Provider value={store}>{props.children}</Ctx.Provider>;
}
