import { join } from "node:path";
import { useEffect, useState } from "react";
import { prepForApplication } from "../../ai/prep.ts";
import { addDays, APPLICATIONS_DIR, followUpsDue, learn, listApplications, saveApplicationRecord, setStatus, STATUSES, type Application, type Learning, type Status } from "../../applications.ts";
import { openPath } from "../actions.ts";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane, split, windowStart, wrap } from "../ui.tsx";

const STATUS_COLOR: Record<Status, string> = { draft: C.dim, applied: C.info, interview: C.accent, offer: C.ok, rejected: C.err, withdrawn: C.dim };
const today = () => new Date().toISOString().slice(0, 10);

/** Application tracker: status, follow-ups, interview prep, and what's working. */
export function ApplicationsView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent }) {
  const store = useStore();
  const [apps, setApps] = useState<Application[]>([]);
  const [learning, setLearning] = useState<Learning>();
  const [sel, setSel] = useState(0);
  const reload = async () => {
    const list = await listApplications();
    setApps(list);
    setLearning(await learn(list));
  };
  useEffect(() => {
    void reload();
  }, []);

  const current = apps[Math.min(sel, apps.length - 1)];
  const due = new Set(followUpsDue(apps).map((a) => a.slug));

  async function update(next: Application) {
    await saveApplicationRecord(next);
    await reload();
  }

  useKeys(props.active, async (key) => {
    if (key.name === "up" || key.name === "k") return setSel((s) => Math.max(0, s - 1));
    if (key.name === "down" || key.name === "j") return setSel((s) => Math.min(apps.length - 1, s + 1));
    if (key.name === "escape" || key.name === "left") return props.onBack();
    if (!current) return;
    if (key.name === "s") {
      const picked = await store.choose(`Status for ${current.company ?? current.slug}`, STATUSES.map((s) => ({ value: s, label: s, hint: s === current.status ? "current" : undefined })));
      if (picked?.[0] && picked[0] !== current.status) {
        await setStatus(current, picked[0]);
        await reload();
        store.flash(`${current.company ?? current.slug}: ${picked[0]}`, "ok");
      }
    } else if (key.name === "f") {
      const input = await store.prompt("Follow up on (YYYY-MM-DD, or +N days; empty clears)", current.followUp ?? `+7`);
      if (input === null) return;
      const v = input.trim();
      const date = v.startsWith("+") ? addDays(today(), Number(v.slice(1)) || 7) : v;
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return store.flash("Use YYYY-MM-DD or +N", "warn");
      await update({ ...current, followUp: date || undefined });
    } else if (key.name === "n") {
      const notes = await store.prompt("Notes", current.notes ?? "");
      if (notes !== null) await update({ ...current, notes: notes || undefined });
    } else if (key.name === "i") {
      const ai = await store.getAI();
      if (!ai) return;
      const res = await store.run("Preparing interview questions", () => prepForApplication(ai, store.resume, current.slug));
      if (!res) return;
      const gaps = res.questions.filter((q) => q.gap).length;
      store.flash(`${res.questions.length} questions written to ${res.file}${gaps ? `; ${gaps} have no evidence yet` : ""}`, gaps ? "warn" : "ok");
      openPath(res.file);
    } else if (key.name === "o") openPath(join(APPLICATIONS_DIR, current.slug));
  });

  const listW = Math.max(30, Math.floor(props.width * 0.45));
  const rightW = props.width - listW;
  const inner = rightW - 4;
  const bodyH = props.height - 3;
  const start = windowStart(sel, apps.length, bodyH);
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <box flexDirection="row" width={props.width} height={props.height}>
      <Pane title={`Applications (${apps.length})${due.size ? ` · ${due.size} follow-up due` : ""}`} active={props.active} width={listW}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} height={bodyH}>
          {!apps.length && wrap("No applications yet. Tailor to a job posting and it appears here as a draft.", listW - 4).map((l, i) => <Line key={i} text={l} fg={C.dim} />)}
          {apps.slice(start, start + bodyH).map((a, j) => {
            const i = start + j;
            return (
              <Line
                key={a.slug}
                text={split(`${due.has(a.slug) ? "⏰ " : ""}${a.company ?? a.slug}${a.title ? ` — ${a.title}` : ""}`, a.status, listW - 4)}
                fg={STATUS_COLOR[a.status]}
                bg={i === sel ? (props.active ? C.sel : C.selDim) : undefined}
              />
            );
          })}
        </box>
        <box paddingLeft={1}>
          <Hints keys={[["s", "status"], ["f", "follow-up"], ["n", "notes"], ["i", "interview prep"], ["o", "open"]]} />
        </box>
      </Pane>
      <Pane title={current ? (current.company ?? current.slug) : "What's working"} width={rightW}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          {current && (
            <>
              <Line text={fit(current.title ?? "", inner)} fg={C.accent} bold />
              <Line text={fit(`${current.status}${current.followUp ? ` · follow up ${current.followUp}` : ""}${current.coverage !== undefined ? ` · ${pct(current.coverage)} keyword coverage` : ""}`, inner)} fg={STATUS_COLOR[current.status]} />
              <Line text={fit(`variant: ${current.variant ?? "—"}`, inner)} fg={C.dim} />
              {current.notes && wrap(current.notes, inner).map((l, i) => <Line key={`n${i}`} text={l} />)}
              <Line text={fit(current.history.map((h) => `${h.date} ${h.status}`).join(" → "), inner)} fg={C.dim} />
              <box height={1} />
            </>
          )}
          {learning && (
            <>
              <Line text="WHAT'S WORKING" fg={C.accent} />
              <Line text={fit(`${learning.sent} sent · ${learning.responses} got a response${learning.sent ? ` (${pct(learning.responses / learning.sent)})` : ""}`, inner)} />
              {learning.byVariant.slice(0, 4).map((s) => (
                <Line key={s.key} text={fit(`  ${s.key}: ${s.responses}/${s.sent} responded`, inner)} fg={C.dim} />
              ))}
              {learning.insights.flatMap((t, i) => wrap(t, inner).map((l, j) => <Line key={`i${i}-${j}`} text={l} fg={C.info} />))}
            </>
          )}
        </box>
      </Pane>
    </box>
  );
}
