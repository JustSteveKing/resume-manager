import { useMemo, useState } from "react";
import { lint, type Issue } from "../../lint.ts";
import { sectionByKey } from "../../sections.ts";
import { sortRecent } from "../../sort.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane, windowStart, wrap } from "../ui.tsx";

const ICON = { error: "✖", warn: "▲", info: "·" } as const;
const COLOR = { error: C.err, warn: C.warn, info: C.dim } as const;

export function IssuesView(props: {
  active: boolean;
  width: number;
  height: number;
  onBack: () => void;
  onJump: (section: string, index?: number) => void;
}) {
  const store = useStore();
  const issues = useMemo(() => lint(store.resume), [store.resume]);
  const [sel, setSel] = useState(0);
  const current: Issue | undefined = issues[Math.min(sel, issues.length - 1)];
  const w = props.width - 4;
  const detailH = 5;
  const bodyH = props.height - 3 - detailH;
  const start = windowStart(sel, issues.length, bodyH);

  useKeys(props.active, async (key) => {
    if (key.name === "up" || key.name === "k") setSel((s) => Math.max(0, s - 1));
    else if (key.name === "down" || key.name === "j") setSel((s) => Math.min(issues.length - 1, s + 1));
    else if (key.name === "escape" || key.name === "left") props.onBack();
    else if (key.name === "return" && current) {
      if (current.unsorted) {
        const s = sectionByKey(current.unsorted);
        if (await store.confirm(`Sort ${s.label} newest first?`)) {
          store.update((r) => void sortRecent(r[s.key] as Record<string, any>[]), `sort ${s.label}`);
          store.flash(`Sorted ${s.label}`, "ok");
        }
      } else if (current.target) props.onJump(current.target.section, current.target.index);
    }
  });

  const counts = (["error", "warn", "info"] as const).map((l) => `${ICON[l]} ${issues.filter((i) => i.level === l).length}`).join("  ");

  return (
    <Pane title={`Issues  ${counts}`} active={props.active} width={props.width}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        {!issues.length && <Line text="✔ Valid JSON Resume, no issues" fg={C.ok} />}
        <box flexDirection="column" height={bodyH}>
          {issues.slice(start, start + bodyH).map((issue, j) => {
            const i = start + j;
            return (
              <Line
                key={i}
                text={fit(`${ICON[issue.level]} ${issue.group.padEnd(8)} ${issue.message}`, w)}
                fg={COLOR[issue.level]}
                bg={i === sel ? (props.active ? C.sel : C.selDim) : undefined}
              />
            );
          })}
        </box>
        <box flexDirection="column" height={detailH} border={["top"]} borderColor={C.border}>
          {current && wrap(current.message, w).slice(0, detailH - 2).map((l, i) => <Line key={i} text={l} />)}
        </box>
        <Hints
          keys={[
            ["↑↓", "select"],
            ["enter", current?.unsorted ? "sort" : current?.target ? "go to" : "—"],
            ["esc", "back"],
          ]}
        />
      </box>
    </Pane>
  );
}
