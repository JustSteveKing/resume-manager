import type { ReactNode } from "react";

export const C = {
  bg: "#0f1117",
  panel: "#141824",
  border: "#2a3142",
  borderActive: "#7aa2f7",
  text: "#c8d3f5",
  dim: "#6b7394",
  accent: "#7aa2f7",
  ok: "#9ece6a",
  warn: "#e0af68",
  err: "#f7768e",
  info: "#7dcfff",
  sel: "#283457",
  selDim: "#1d2333",
} as const;

export type Level = "info" | "ok" | "warn" | "error";
export const levelColor = (l: Level) => ({ info: C.info, ok: C.ok, warn: C.warn, error: C.err })[l];

/** Truncate or pad to exactly w columns. */
export function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const flat = s.replace(/\s*\n\s*/g, " ⏎ ");
  return flat.length > w ? `${flat.slice(0, Math.max(0, w - 1))}…` : flat.padEnd(w);
}

/** Left text and right text on one line of width w. */
export function split(left: string, right: string, w: number): string {
  if (!right) return fit(left, w);
  const r = right.length + 1 >= w ? "" : right;
  return fit(left, w - r.length - (r ? 1 : 0)) + (r ? ` ${r}` : "");
}

/** Greedy word wrap, preserving explicit newlines. */
export function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > w) {
        out.push(line.slice(0, w));
        line = line.slice(w);
      }
    }
    out.push(line);
  }
  return out;
}

export function Pane(props: {
  title: string;
  active?: boolean;
  width?: number | "auto" | `${number}%`;
  flexGrow?: number;
  children?: ReactNode;
  footer?: string;
}) {
  return (
    <box
      // OpenTUI drops a border title that does not fit, so truncate it ourselves.
      title={` ${typeof props.width === "number" ? fit(props.title, props.width - 6).trimEnd() : props.title} `}
      titleAlignment="left"
      border
      borderStyle="rounded"
      borderColor={props.active ? C.borderActive : C.border}
      width={props.width}
      flexGrow={props.flexGrow}
      flexDirection="column"
      overflow="hidden"
      bottomTitle={props.footer ? ` ${props.footer} ` : undefined}
      bottomTitleAlignment="right"
    >
      {props.children}
    </box>
  );
}

/** One full-width line of text; highlighted when selected. */
export function Line(props: { text: string; fg?: string; bg?: string; bold?: boolean }) {
  return (
    <box height={1} backgroundColor={props.bg} overflow="hidden">
      <text wrapMode="none" fg={props.fg ?? C.text}>
        {props.bold ? <strong>{props.text}</strong> : props.text}
      </text>
    </box>
  );
}

/** "key label · key label" hint strip. */
export function Hints({ keys }: { keys: [string, string][] }) {
  return (
    <text wrapMode="none">
      {keys.map(([k, label], i) => (
        <span key={k} fg={C.dim}>
          {i ? "  " : ""}
          <span fg={C.accent}>{k}</span> {label}
        </span>
      ))}
    </text>
  );
}

/** Keep the selected row visible: returns the first row index to render. */
export function windowStart(selected: number, count: number, height: number): number {
  if (count <= height) return 0;
  return Math.min(Math.max(0, selected - Math.floor(height / 2)), count - height);
}
