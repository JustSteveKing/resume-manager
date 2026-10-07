import { useEffect, useState } from "react";
import { refreshSources, removeSource, sourceLabel, type RefreshResult } from "../../sources.ts";
import { mergeBasics, mergeItems } from "../flows.ts";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, Hints, Line, Pane, split, windowStart } from "../ui.tsx";

export function SourcesView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent }) {
  const store = useStore();
  const sources = store.resume.meta?.sources ?? [];
  const [sel, setSel] = useState(0);
  const [log, setLog] = useState<{ text: string; fg?: string }[]>([]);
  const current = sources[Math.min(sel, sources.length - 1)];

  async function refresh() {
    if (!sources.length) return store.flash("No saved sources yet. Import with \"Save as source\" on.", "info");
    const results = await store.run("Refreshing sources", (progress) => {
      // Work on a copy so lastRun updates go through update() and get saved.
      const copy = structuredClone(store.resume);
      return refreshSources(copy, (s) => progress(sourceLabel(s))).then((res) => {
        store.update((r) => {
          r.meta = { ...r.meta, sources: copy.meta?.sources };
        }, "refresh sources");
        return res;
      });
    });
    if (!results) return;
    const lines: { text: string; fg?: string }[] = [];
    for (const res of results as RefreshResult[]) {
      if (res.kind === "error") lines.push({ text: `✖ ${sourceLabel(res.source)}: ${res.error}`, fg: C.err });
      if (res.kind === "items") {
        lines.push({ text: `${sourceLabel(res.source)}: ${res.fresh.length} new`, fg: res.fresh.length ? C.ok : C.dim });
        if (res.fresh.length) await mergeItems(store, res.section, res.fresh, `New from ${sourceLabel(res.source)}`);
      }
      if (res.kind === "basics") {
        lines.push({ text: `${sourceLabel(res.source)}: profile` });
        await mergeBasics(store, res.found);
      }
    }
    setLog(lines);
  }

  useEffect(() => {
    if (props.intent?.action === "run") void refresh();
  }, [props.intent?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useKeys(props.active, async (key) => {
    if (key.name === "up" || key.name === "k") setSel((s) => Math.max(0, s - 1));
    else if (key.name === "down" || key.name === "j") setSel((s) => Math.min(Math.max(0, sources.length - 1), s + 1));
    else if (key.name === "escape" || key.name === "left") props.onBack();
    else if (key.name === "r") refresh();
    else if (key.name === "d" && current) {
      if (!(await store.confirm(`Remove source ${sourceLabel(current)}?`))) return;
      store.update((r) => {
        const target = r.meta?.sources?.find((s) => s.url === current.url && s.target === current.target);
        if (target) removeSource(r, target);
      }, `remove source ${sourceLabel(current)}`);
      setSel((s) => Math.max(0, s - 1));
    }
  });

  const w = props.width - 4;
  const logH = Math.max(3, Math.min(10, log.length + 1));
  const bodyH = props.height - 4 - logH;
  const start = windowStart(sel, sources.length, bodyH);

  return (
    <Pane title={`Sources (${sources.length})`} active={props.active} width={props.width}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        <box flexDirection="column" height={bodyH}>
          {!sources.length && <Line text={'No saved sources. Import from web with "Save as source" on.'} fg={C.dim} />}
          {sources.slice(start, start + bodyH).map((s, j) => {
            const i = start + j;
            return (
              <Line
                key={`${s.url}-${s.target}`}
                text={split(sourceLabel(s), s.lastRun ? `last run ${s.lastRun.slice(0, 10)}` : "never run", w)}
                bg={i === sel ? (props.active ? C.sel : C.selDim) : undefined}
              />
            );
          })}
        </box>
        <box flexDirection="column" height={logH} border={["top"]} borderColor={C.border}>
          {log.map((l, i) => (
            <Line key={i} text={l.text} fg={l.fg} />
          ))}
        </box>
        <Hints keys={[["r", "refresh all"], ["d", "remove"], ["esc", "back"]]} />
      </box>
    </Pane>
  );
}
