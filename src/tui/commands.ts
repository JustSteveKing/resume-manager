// Every action the TUI offers, as data: the command palette searches these, and the welcome
// screen and views reuse them.

export interface Command {
  id: string;
  label: string;
  /** Extra words to match on ("pdf", "linkedin"…). */
  keywords?: string;
  /** Shortcut shown on the right. */
  keys?: string;
  group: "Go to" | "Edit" | "Import" | "Output" | "App";
  run: () => void | Promise<void>;
}

/** Something a view should do when it opens: add an entry, run a scan, select a row. */
export interface Intent {
  view: string;
  action: string;
  payload?: unknown;
  /** Changes every time, so the same intent can fire twice. */
  n: number;
}

/**
 * Rank commands for a query. Every query word must appear in the label or keywords;
 * earlier and word-start matches rank higher. An empty query keeps the given order.
 */
export function searchCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  const scored: { c: Command; score: number }[] = [];
  for (const c of commands) {
    const label = c.label.toLowerCase();
    const hay = `${label} ${c.keywords?.toLowerCase() ?? ""} ${c.group.toLowerCase()}`;
    let score = 0;
    let ok = true;
    for (const w of words) {
      const at = hay.indexOf(w);
      if (at < 0) {
        ok = false;
        break;
      }
      const inLabel = label.indexOf(w);
      const wordStart = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label);
      score += (inLabel >= 0 ? inLabel : 100 + at) - (wordStart ? 50 : 0);
    }
    if (ok) scored.push({ c, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.c);
}
