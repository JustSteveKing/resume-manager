import { useEffect, useMemo, useState } from "react";
import { cachedRepos, describeEvidence, evidenceMap, STATUS_TEXT, type SkillEvidence } from "../../evidence.ts";
import type { RepoAnalysis } from "../../repos/analyze.ts";
import type { Intent } from "../commands.ts";
import { useKeys, useStore } from "../store.tsx";
import { C, fit, Hints, Line, Pane, split, windowStart } from "../ui.tsx";

const FILTERS = ["problems", "all", "unlisted"] as const;
const COLOR: Record<SkillEvidence["status"], string> = { strong: C.ok, ok: C.text, weak: C.warn, unsupported: C.err, stale: C.warn, unlisted: C.info };

/** Skill evidence map: what backs up each skill, and what's missing. */
export function EvidenceView(props: { active: boolean; width: number; height: number; onBack: () => void; intent?: Intent }) {
  const store = useStore();
  const [gh, setGh] = useState<RepoAnalysis>();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("problems");
  const [sel, setSel] = useState(0);
  useEffect(() => {
    cachedRepos(store.resume).then(setGh, () => setGh(undefined));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const all = useMemo(() => evidenceMap(store.resume, gh), [store.resume, gh]);
  const shown = all.filter((e) => (filter === "all" ? true : filter === "unlisted" ? e.status === "unlisted" : ["unsupported", "stale", "weak"].includes(e.status)));
  const current = shown[Math.min(sel, shown.length - 1)];
  const counts = all.reduce<Record<string, number>>((acc, e) => ((acc[e.status] = (acc[e.status] ?? 0) + 1), acc), {});

  useKeys(props.active, async (key) => {
    if (key.name === "up" || key.name === "k") setSel((s) => Math.max(0, s - 1));
    else if (key.name === "down" || key.name === "j") setSel((s) => Math.min(shown.length - 1, s + 1));
    else if (key.name === "f") {
      setFilter((f) => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length]!);
      setSel(0);
    } else if (key.name === "escape" || key.name === "left") props.onBack();
    else if (key.name === "a" && current?.status === "unlisted") {
      const group = current.group && store.resume.skills.some((s) => s.name === current.group) ? current.group : (store.resume.skills[0]?.name ?? "Skills");
      store.update((r) => {
        const g = r.skills.find((s) => s.name === group) ?? (r.skills.push({ name: group, keywords: [] }), r.skills.at(-1)!);
        g.keywords = [...(g.keywords ?? []), current.skill];
      }, `add skill ${current.skill}`);
      store.flash(`Added ${current.skill} to ${group}`, "ok");
    } else if (key.name === "d" && current?.listed) {
      if (!(await store.confirm(`Remove "${current.skill}" from Skills?`))) return;
      store.update((r) => {
        for (const g of r.skills) g.keywords = g.keywords?.filter((k) => k !== current.skill);
        r.skills = r.skills.filter((g) => g.keywords?.length || g.name !== current.skill);
      }, `remove skill ${current.skill}`);
    }
  });

  const listW = Math.max(30, Math.floor(props.width * 0.45));
  const rightW = props.width - listW;
  const bodyH = props.height - 4;
  const start = windowStart(sel, shown.length, bodyH);
  const summary = `${counts.strong ?? 0} strong · ${counts.ok ?? 0} ok · ${(counts.weak ?? 0) + (counts.stale ?? 0)} weak/stale · ${counts.unsupported ?? 0} unsupported · ${counts.unlisted ?? 0} unlisted`;

  return (
    <box flexDirection="row" width={props.width} height={props.height}>
      <Pane title={`Evidence · ${filter}`} active={props.active} width={listW}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} height={props.height - 2}>
          <Line text={fit(summary, listW - 4)} fg={C.dim} />
          <box flexDirection="column" height={bodyH}>
            {!shown.length && <Line text={filter === "problems" ? "No problems: every listed skill has evidence." : "Nothing here."} fg={C.ok} />}
            {shown.slice(start, start + bodyH).map((e, j) => {
              const i = start + j;
              return <Line key={e.skill} text={split(e.skill, e.status, listW - 4)} fg={COLOR[e.status]} bg={i === sel ? (props.active ? C.sel : C.selDim) : undefined} />;
            })}
          </box>
          <Hints keys={[["f", "filter"], ["a", "add unlisted"], ["d", "remove"], ["esc", "back"]]} />
        </box>
      </Pane>
      <Pane title={current?.skill ?? "—"} width={rightW}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          {current && (
            <>
              <Line text={fit(STATUS_TEXT[current.status], rightW - 4)} fg={COLOR[current.status]} />
              <Line text={fit(`${current.group ?? ""}${current.group ? " · " : ""}${describeEvidence(current)}`, rightW - 4)} fg={C.dim} />
              <box height={1} />
              {current.proofs.slice(0, props.height - 9).map((p, i) => (
                <Line key={i} text={fit(`${p.kind.padEnd(8)} ${p.label}${p.when ? ` (${p.when.slice(0, 4)})` : ""}`, rightW - 4)} />
              ))}
              {!current.proofs.length && <Line text={fit("Nothing in your roles, projects, talks or GitHub mentions this.", rightW - 4)} fg={C.warn} />}
              {!current.proofs.length && <Line text={fit("Add a highlight that shows it, or drop it from Skills.", rightW - 4)} fg={C.dim} />}
              {!gh && <Line text={fit("Tip: scan your GitHub/GitLab (Repositories) to include repo evidence.", rightW - 4)} fg={C.info} />}
            </>
          )}
        </box>
      </Pane>
    </box>
  );
}
