import type { TextareaRenderable } from "@opentui/core";
import { useMemo, useRef, useState } from "react";
import { draftBullets, interviewQuestions, rolesNeedingWork, type Question } from "../../ai/coach.ts";
import { getAI } from "../../ai/index.ts";
import { formatRange } from "../../dates.ts";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane, windowStart, wrap } from "../ui.tsx";

type Session = { role: number; questions: Question[]; answers: string[]; at: number };

/** Achievement interviewer: ask about a role, turn the answers into quantified bullets. */
export function CoachView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent }) {
  const store = useStore();
  const work = store.resume.work;
  const flagged = useMemo(() => new Map(rolesNeedingWork(store.resume).map((x) => [x.index, x.reasons])), [store.resume]);
  // Roles that need work first, then the rest in resume order.
  const order = useMemo(() => [...work.keys()].sort((a, b) => Number(flagged.has(b)) - Number(flagged.has(a)) || a - b), [work, flagged]);
  const [sel, setSel] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const answerRef = useRef<TextareaRenderable>(null);
  const roleIndex = order[Math.min(sel, order.length - 1)];
  const role = roleIndex === undefined ? undefined : work[roleIndex];

  async function start() {
    if (roleIndex === undefined || !role) return;
    // Template questions are a fine fallback, so a missing AI key is not an error here.
    const ai = store.ai ?? (await getAI(store.resume).catch(() => undefined));
    const questions = (await store.run("Thinking of questions", () => interviewQuestions(ai, role))) ?? [];
    if (!questions.length) return;
    setSession({ role: roleIndex, questions, answers: questions.map(() => ""), at: 0 });
    store.setEditing(true);
  }

  async function finish(s: Session) {
    store.setEditing(false);
    setSession(null);
    const w = store.resume.work[s.role];
    if (!w) return;
    const answers = s.questions.map((q, i) => ({ question: q.question, answer: s.answers[i] ?? "" })).filter((a) => a.answer.trim());
    if (!answers.length) return store.flash("No answers, nothing to add", "info");
    const ai = await store.getAI();
    let candidates: string[];
    let note = "";
    if (ai) {
      const drafted = await store.run("Drafting bullets from your answers", () => draftBullets(ai, w, answers));
      if (!drafted) return;
      candidates = drafted.bullets;
      if (drafted.dropped.length) note = ` (${drafted.dropped.length} dropped: numbers not in your answers)`;
    } else {
      // No model: offer the answers themselves as draft highlights to polish by hand.
      candidates = answers.map((a) => a.answer.trim());
    }
    if (!candidates.length) return store.flash(`No bullets survived the fact check${note}`, "warn");
    const picked = await store.choose(`Add to ${w.position ?? w.name}${note}`, candidates.map((c, i) => ({ value: i, label: c, checked: true })), true);
    if (!picked?.length) return;
    store.update((r) => {
      const target = r.work[s.role]!;
      target.highlights = [...(target.highlights ?? []), ...picked.map((i) => candidates[i]!)];
    }, `add ${picked.length} interview bullet(s) to ${w.name}`);
    store.flash(`Added ${picked.length} highlight(s) to ${w.name}. Press u to undo.`, "ok");
  }

  function next() {
    if (!session) return;
    const answers = [...session.answers];
    answers[session.at] = answerRef.current?.plainText ?? "";
    const s = { ...session, answers };
    if (s.at + 1 >= s.questions.length) return void finish(s);
    setSession({ ...s, at: s.at + 1 });
  }

  useKeys(
    props.active,
    (key) => {
      if (session) {
        if (key.name === "escape") {
          store.setEditing(false);
          setSession(null);
        } else if (key.ctrl && key.name === "s") next();
        return;
      }
      if (store.editing) return;
      if (key.name === "up" || key.name === "k") setSel((s) => Math.max(0, s - 1));
      else if (key.name === "down" || key.name === "j") setSel((s) => Math.min(order.length - 1, s + 1));
      else if (key.name === "return" || key.name === "right") void start();
      else if (key.name === "escape" || key.name === "left") props.onBack();
    },
    true,
  );

  const listW = Math.max(28, Math.floor(props.width * 0.38));
  const rightW = props.width - listW;
  const inner = rightW - 4;
  const bodyH = props.height - 3;
  const start0 = windowStart(sel, order.length, bodyH);

  let right;
  if (session) {
    const q = session.questions[session.at]!;
    right = (
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        <Line text={fit(`Question ${session.at + 1} of ${session.questions.length}`, inner)} fg={C.dim} />
        {wrap(q.question, inner).map((l, i) => (
          <Line key={i} text={l} fg={C.accent} bold />
        ))}
        <Line text={fit(q.why, inner)} fg={C.dim} />
        <box height={1} />
        <box border borderStyle="rounded" borderColor={C.borderActive} height={Math.max(4, props.height - 12)}>
          <textarea
            key={session.at}
            ref={answerRef}
            focused
            initialValue={session.answers[session.at] ?? ""}
            placeholder="Your answer: rough notes are fine, numbers are gold"
            wrapMode="word"
            backgroundColor={C.panel}
            focusedBackgroundColor={C.panel}
            textColor={C.text}
            keyBindings={[{ name: "s", ctrl: true, action: "submit" }]}
            onSubmit={next}
          />
        </box>
        <box flexGrow={1} />
        <Hints keys={[["ctrl+s", session.at + 1 < session.questions.length ? "next question" : "finish & draft"], ["empty", "skip"], ["esc", "stop"]]} />
      </box>
    );
  } else if (role) {
    const reasons = flagged.get(roleIndex!) ?? [];
    right = (
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
        <Line text={fit([role.position, role.name].filter(Boolean).join(" @ "), inner)} fg={C.accent} bold />
        <Line text={fit(formatRange(role.startDate, role.endDate), inner)} fg={C.dim} />
        <box height={1} />
        {reasons.length ? <Line text={fit(`Needs: ${reasons.join(", ")}`, inner)} fg={C.warn} /> : <Line text="Looks good. You can still interview for more." fg={C.ok} />}
        <box height={1} />
        {(role.highlights ?? []).slice(0, Math.max(0, props.height - 12)).flatMap((h, i) => wrap(`• ${h}`, inner).map((l, j) => <Line key={`${i}-${j}`} text={l} />))}
        <box flexGrow={1} />
        {wrap("Answer 2-3 quick questions about this role; your answers become quantified bullets you can accept or skip. Only numbers you give are used.", inner).map((l, i) => (
          <Line key={`h${i}`} text={l} fg={C.dim} />
        ))}
        <Hints keys={[["enter", "start interview"], ["↑↓", "role"], ["esc", "back"]]} />
      </box>
    );
  }

  return (
    <box flexDirection="row" width={props.width} height={props.height}>
      <Pane title={`Coach · ${flagged.size} role(s) to strengthen`} active={props.active && !session} width={listW}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} height={bodyH}>
          {!order.length && <Line text="Add some work entries first." fg={C.dim} />}
          {order.slice(start0, start0 + bodyH).map((idx, j) => {
            const i = start0 + j;
            const w = work[idx]!;
            const need = flagged.get(idx);
            return (
              <Line
                key={idx}
                text={fit(`${need ? "▲ " : "  "}${[w.position, w.name].filter(Boolean).join(" · ")}`, listW - 4)}
                fg={need ? C.warn : C.text}
                bg={i === sel ? (props.active && !session ? C.sel : C.selDim) : undefined}
              />
            );
          })}
        </box>
      </Pane>
      <Pane title={session ? "Interview" : "Role"} active={props.active && !!session} width={rightW}>
        {right}
      </Pane>
    </box>
  );
}
