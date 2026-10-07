import type { Issue } from "../lint.ts";

export const print = (s = "") => console.log(s);
const ICON = { error: "✖", warn: "▲", info: "·" } as const;

export function printIssues(issues: Issue[]) {
  if (!issues.length) return print("✔ Valid JSON Resume, no issues");
  for (const group of ["schema", "content", "order", "writing", "consistency"] as const) {
    const items = issues.filter((i) => i.group === group);
    if (!items.length) continue;
    print(`\n${group.toUpperCase()}`);
    items.forEach((i) => print(`  ${ICON[i.level]} ${i.message}`));
  }
}
