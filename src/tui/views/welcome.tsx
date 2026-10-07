import { useState } from "react";
import { useKeys } from "../store.tsx";
import { C, fit, Hints, Line, Pane, wrap } from "../ui.tsx";

export interface WelcomeChoice {
  label: string;
  detail: string;
  run: () => void | Promise<void>;
}

/** First-run screen: the quickest ways to get a resume in, instead of an empty form. */
export function WelcomeView(props: { active: boolean; width: number; height: number; choices: WelcomeChoice[]; onDismiss: () => void }) {
  const [sel, setSel] = useState(0);
  const w = props.width - 6;

  useKeys(props.active, (key) => {
    if (key.name === "up" || key.name === "k") setSel((s) => Math.max(0, s - 1));
    else if (key.name === "down" || key.name === "j") setSel((s) => Math.min(props.choices.length - 1, s + 1));
    else if (key.name === "return" || key.name === "right") void props.choices[sel]?.run();
    else if (key.name === "escape") props.onDismiss();
    else if (/^[1-9]$/.test(key.name)) void props.choices[Number(key.name) - 1]?.run();
  });

  return (
    <Pane title="Welcome" active={props.active} width={props.width}>
      <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} height={props.height - 2}>
        <Line text="Let's get your resume in." fg={C.accent} bold />
        <Line text={fit("Everything saves to resume.json as you go, and u undoes any change.", w)} fg={C.dim} />
        <box height={1} />
        {props.choices.map((c, i) => {
          const selected = i === sel;
          return (
            <box key={c.label} flexDirection="column" marginBottom={1} paddingLeft={1} backgroundColor={selected ? C.sel : undefined}>
              <Line text={fit(`${i + 1}  ${c.label}`, w - 1)} fg={selected ? C.text : C.text} bold={selected} bg={selected ? C.sel : undefined} />
              {wrap(c.detail, w - 4).map((l, j) => (
                <Line key={j} text={`   ${l}`} fg={C.dim} bg={selected ? C.sel : undefined} />
              ))}
            </box>
          );
        })}
        <box flexGrow={1} />
        <Line text={fit("Tip: press : at any time to search every action.", w)} fg={C.info} />
        <Hints keys={[["↑↓", "choose"], ["enter", "start"], ["1-4", "pick"], ["esc", "skip"]]} />
      </box>
    </Pane>
  );
}
