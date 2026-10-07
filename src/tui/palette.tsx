import { useState } from "react";
import { searchCommands, type Command } from "./commands.ts";
import { useKeys } from "./store.tsx";
import { C, fit, Hints, Line, split, windowStart } from "./ui.tsx";

/** Command palette overlay: type to filter, ↑↓ to choose, enter to run. */
export function Palette(props: { commands: Command[]; width: number; height: number; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const results = searchCommands(props.commands, query);
  const w = Math.min(props.width - 6, 76);
  const inner = w - 4;
  const rows = Math.max(3, Math.min(results.length || 1, props.height - 10, 16));
  const at = Math.min(sel, Math.max(0, results.length - 1));
  const start = windowStart(at, results.length, rows);

  const run = (c: Command | undefined) => {
    if (!c) return;
    props.onClose();
    void c.run();
  };

  // The palette's own <input> has focus; this only adds list navigation and escape.
  useKeys(
    true,
    (key) => {
      if (key.name === "escape") props.onClose();
      else if (key.name === "down" || (key.ctrl && key.name === "n")) setSel((s) => Math.min(results.length - 1, s + 1));
      else if (key.name === "up" || (key.ctrl && key.name === "p")) setSel((s) => Math.max(0, s - 1));
    },
    true,
    true,
  );

  return (
    <box
      position="absolute"
      left={Math.floor((props.width - w) / 2)}
      top={2}
      width={w}
      height={rows + 5}
      border
      borderStyle="rounded"
      borderColor={C.borderActive}
      backgroundColor={C.panel}
      title=" Go to or do anything "
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      zIndex={200}
    >
      <box flexDirection="row" height={1}>
        <text fg={C.accent} width={2}>
          {"› "}
        </text>
        <input
          focused
          value={query}
          width={inner - 2}
          placeholder="type to search: export pdf, import json, add work, sort…"
          backgroundColor={C.panel}
          focusedBackgroundColor={C.panel}
          textColor={C.text}
          onInput={(v) => {
            setQuery(String(v));
            setSel(0);
          }}
          onSubmit={() => run(results[at])}
        />
      </box>
      <box flexDirection="column" height={rows} marginTop={1}>
        {!results.length && <Line text={fit(`No action matches "${query}"`, inner)} fg={C.dim} />}
        {results.slice(start, start + rows).map((c, j) => {
          const i = start + j;
          return (
            <Line
              key={c.id}
              text={split(`${c.group === "Go to" ? "→ " : "  "}${c.label}`, c.keys ?? c.group.toLowerCase(), inner)}
              bg={i === at ? C.sel : undefined}
              fg={i === at ? C.text : undefined}
            />
          );
        })}
      </box>
      <Hints keys={[["↑↓", "choose"], ["enter", "run"], ["esc", "close"]]} />
    </box>
  );
}
