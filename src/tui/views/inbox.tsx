import { useEffect, useState } from "react";
import { applySuggestion, loadSuggestions, resolveSuggestion, runInbox, type Suggestion } from "../../inbox.ts";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane, windowStart, wrap } from "../ui.tsx";

/** Brag-doc inbox: new talks, repos and milestones since the last check, to accept or dismiss. */
export function InboxView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent; onChange?: (count: number) => void }) {
  const store = useStore();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [sel, setSel] = useState(0);
  const [note, setNote] = useState<string>();
  const reload = async () => {
    const list = await loadSuggestions();
    setItems(list);
    props.onChange?.(list.length);
  };
  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    if (props.intent?.action === "run") void check();
  }, [props.intent?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  async function check() {
    const res = await store.run("Checking for new achievements", (progress) => runInbox(store.resume, { onProgress: progress }));
    if (!res) return;
    await reload();
    setNote(
      res.baseline
        ? "First check: GitHub baseline recorded. Future checks report new repos and star milestones."
        : res.added.length
          ? `${res.added.length} new suggestion(s)`
          : "Nothing new since last check",
    );
    res.errors.forEach((e) => store.flash(e, "warn"));
  }

  const current = items[Math.min(sel, items.length - 1)];
  useKeys(props.active, async (key) => {
    if (key.name === "up" || key.name === "k") setSel((s) => Math.max(0, s - 1));
    else if (key.name === "down" || key.name === "j") setSel((s) => Math.min(items.length - 1, s + 1));
    else if (key.name === "escape" || key.name === "left") props.onBack();
    else if (key.name === "r") void check();
    else if ((key.name === "return" || key.name === "y") && current) {
      store.update((r) => applySuggestion(r, current), `accept: ${current.title}`);
      await resolveSuggestion(current.id, false);
      await reload();
      store.flash(`Added: ${current.title}. Press u to undo.`, "ok");
    } else if (key.name === "d" && current) {
      await resolveSuggestion(current.id, true);
      await reload();
    }
  });

  const w = props.width - 4;
  const bodyH = props.height - 8;
  const start = windowStart(sel, items.length, bodyH);
  return (
    <Pane title={`Inbox (${items.length})`} active={props.active} width={props.width}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        <box flexDirection="column" height={bodyH}>
          {!items.length &&
            wrap("No suggestions. Press r to check your saved sources and GitHub for new talks, articles, repos and star milestones. Schedule it with: cv inbox", w).map((l, i) => (
              <Line key={i} text={l} fg={C.dim} />
            ))}
          {items.slice(start, start + bodyH).map((s, j) => {
            const i = start + j;
            return <Line key={s.id} text={fit(`${s.createdAt.slice(0, 10)}  ${s.title}`, w)} bg={i === sel ? (props.active ? C.sel : C.selDim) : undefined} />;
          })}
        </box>
        <box flexDirection="column" height={4} border={["top"]} borderColor={C.border}>
          {current && wrap(current.detail, w).slice(0, 2).map((l, i) => <Line key={i} text={l} fg={C.dim} />)}
          {note && <Line text={fit(note, w)} fg={C.info} />}
        </box>
        <Hints keys={[["enter", "accept"], ["d", "dismiss"], ["r", "check now"], ["esc", "back"]]} />
      </box>
    </Pane>
  );
}
