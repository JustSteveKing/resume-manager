import { useStore, type ChoiceOption } from "./store.tsx";
import { C, fit, Hints, Line, split, windowStart, wrap } from "./ui.tsx";

export const HELP: [string, string][] = [
  [":  or ctrl+p", "search every action (start here)"],
  ["tab", "switch between navigation and the main pane"],
  ["↑↓ / j k", "move"],
  ["enter / →", "open, edit a field"],
  ["esc / ←", "back"],
  ["u / ctrl+z", "undo any change"],
  ["U / ctrl+y", "redo"],
  ["a / d", "add / delete entry"],
  ["shift+↑↓", "reorder entries or list items"],
  ["s", "sort dated section newest first"],
  ["g", "suggest skills (Skills)"],
  ["x", "clear an optional field"],
  ["ctrl+u", "clear the text while editing a field"],
  ["ctrl+s", "save multi-line text (or meta+enter)"],
  ["r", "run (Import, GitHub, Tailor, Export, Sources)"],
  ["p / o", "check / open PDF"],
  ["w", "rewrite the selected text (writing coach)"],
  ["i", "interview prep (Applications)"],
  ["q / ctrl+c", "quit"],
];

export function ModalView(props: { width: number; height: number; sel: number; checked: boolean[]; promptValue: string; onPromptSubmit: (v: string) => void }) {
  const store = useStore();
  const m = store.modal!;
  const w = Math.min(props.width - 8, m.kind === "help" ? 64 : m.kind === "pick-text" ? 84 : 72);
  const inner = w - 4;

  let body;
  let h = 5;
  if (m.kind === "help") {
    h = HELP.length + 4;
    body = (
      <>
        {HELP.map(([k, d]) => (
          <text key={k} wrapMode="none">
            <span fg={C.accent}>{k.padEnd(14)}</span>
            <span fg={C.text}>{d}</span>
          </text>
        ))}
        <Line text="any key to close" fg={C.dim} />
      </>
    );
  } else if (m.kind === "confirm") {
    body = (
      <>
        <Line text={fit(m.text, inner)} />
        <Hints keys={[["y", "yes"], ["n", "no"]]} />
      </>
    );
  } else if (m.kind === "prompt") {
    body = (
      <>
        <Line text={fit(m.text, inner)} fg={C.dim} />
        <input
          focused
          value={props.promptValue}
          width={inner}
          backgroundColor={C.panel}
          focusedBackgroundColor={C.panel}
          textColor={C.text}
          onSubmit={(v) => props.onPromptSubmit(String(v))}
        />
        <Hints keys={[["enter", "ok"], ["esc", "cancel"]]} />
      </>
    );
  } else if (m.kind === "pick-text") {
    const blocks = m.options.map((o) => wrap(o.text, inner - 4));
    h = Math.min(props.height - 4, blocks.reduce((n, b) => n + b.length + 2, 0) + 3);
    body = (
      <>
        {m.options.map((o, i) => (
          <box key={i} flexDirection="column" backgroundColor={i === props.sel ? C.sel : undefined} marginBottom={1}>
            <Line text={fit(`${i + 1}  ${o.label}`, inner)} fg={i === props.sel ? C.accent : C.dim} bg={i === props.sel ? C.sel : undefined} />
            {blocks[i]!.map((l, j) => (
              <Line key={j} text={`   ${l}`} bg={i === props.sel ? C.sel : undefined} />
            ))}
          </box>
        ))}
        <Hints keys={[["↑↓/1-9", "choose"], ["enter", "use"], ["esc", "keep original"]]} />
      </>
    );
  } else if (m.kind === "choose") {
    const opts = m.options as ChoiceOption<unknown>[];
    const rows = Math.min(opts.length, props.height - 10);
    h = rows + 3;
    const start = windowStart(props.sel, opts.length, rows);
    body = (
      <>
        {opts.slice(start, start + rows).map((o, j) => {
          const i = start + j;
          const mark = m.multi ? (props.checked[i] ? "[x] " : "[ ] ") : "";
          return (
            <Line
              key={i}
              // The label matters more than the hint: cap hints at 40% of the width.
              text={split(`${mark}${o.label}`, o.hint ? fit(o.hint, Math.min(o.hint.length, Math.floor(inner * 0.4))).trimEnd() : "", inner)}
              bg={i === props.sel ? C.sel : undefined}
              fg={o.hint === "already in resume" ? C.dim : undefined}
            />
          );
        })}
        <Hints keys={m.multi ? [["space", "toggle"], ["a", "all/none"], ["enter", "confirm"], ["esc", "cancel"]] : [["enter", "choose"], ["esc", "cancel"]]} />
      </>
    );
  }

  const title = m.kind === "help" ? "Keys" : m.kind === "choose" || m.kind === "pick-text" ? m.text : m.kind === "confirm" ? "Confirm" : "Input";
  return (
    <box
      position="absolute"
      left={Math.floor((props.width - w) / 2)}
      top={Math.max(1, Math.floor((props.height - h) / 2))}
      width={w}
      height={h}
      border
      borderStyle="rounded"
      borderColor={C.borderActive}
      backgroundColor={C.panel}
      title={` ${fit(title, w - 6).trim()} `}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      zIndex={100}
    >
      {body}
    </box>
  );
}

