import { rewrite, type TextKind } from "../ai/coach.ts";
import { Basics, type Work } from "../schema.ts";
import { fieldsFor, type Section } from "../sections.ts";
import { isSortedRecent, sortRecent } from "../sort.ts";
import { isDuplicate } from "../sources.ts";
import { useStore } from "./store.tsx";

type Store = ReturnType<typeof useStore>;
type Item = Record<string, any>;

const truncate = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Let the user pick which extracted entries to add (duplicates unticked), then offer to sort. */
export async function mergeItems(store: Store, section: Section, found: Item[], label?: string): Promise<number> {
  const existing = store.resume[section.key] as Item[];
  const picked = await store.choose(
    label ?? `Add to ${section.label}`,
    found.map((item, i) => {
      const dupe = isDuplicate(section, existing, item);
      return { value: i, label: section.title(item) || "(untitled)", hint: dupe ? "already in resume" : undefined, checked: !dupe };
    }),
    true,
  );
  if (!picked?.length) return 0;
  store.update((r) => (r[section.key] as Item[]).push(...picked.map((i) => found[i]!)), `add ${picked.length} to ${section.label}`);

  const after = [...existing, ...picked.map((i) => found[i]!)];
  if (section.dated && !isSortedRecent(after) && (await store.confirm(`Sort ${section.label} newest first?`))) {
    store.update((r) => void sortRecent(r[section.key] as Item[]), `sort ${section.label}`);
  }
  store.flash(`Added ${picked.length} to ${section.label}`, "ok");
  return picked.length;
}

/** Offer extracted profile fields one by one; fields that would overwrite start unticked. */
export async function mergeBasics(store: Store, found: Partial<Basics>): Promise<void> {
  const b = store.resume.basics;
  type Change = { key: string; label: string; replaces: boolean };
  const changes: Change[] = [];
  for (const f of fieldsFor(Basics)) {
    const next = found[f.key as keyof Basics];
    if (typeof next === "string" && next !== b[f.key as keyof Basics]) {
      changes.push({ key: f.key, label: `${f.label}: ${truncate(next)}`, replaces: !!b[f.key as keyof Basics] });
    }
  }
  if (found.location && Object.keys(found.location).length) {
    changes.push({ key: "location", label: `Location: ${Object.values(found.location).join(", ")}`, replaces: false });
  }
  const known = new Set(b.profiles?.map((p) => p.url));
  const newProfiles = found.profiles?.filter((p) => p.url && !known.has(p.url)) ?? [];
  if (newProfiles.length) {
    changes.push({ key: "profiles", label: `Profiles: ${newProfiles.map((p) => p.network ?? p.url).join(", ")}`, replaces: false });
  }
  if (!changes.length) return store.flash("Nothing new found", "info");

  const picked = await store.choose(
    "Apply which profile fields?",
    changes.map((c) => ({ value: c.key, label: c.label, hint: c.replaces ? "replaces existing" : "new", checked: !c.replaces })),
    true,
  );
  if (!picked?.length) return;
  store.update((r) => {
    for (const key of picked) {
      if (key === "location") r.basics.location = { ...r.basics.location, ...found.location };
      else if (key === "profiles") r.basics.profiles = [...(r.basics.profiles ?? []), ...newProfiles];
      else (r.basics as Record<string, unknown>)[key] = found[key as keyof Basics];
    }
  }, `update ${picked.length} profile field(s)`);
  store.flash(`Updated ${picked.length} field(s)`, "ok");
}

/** Writing coach: ask for rewrites, let the user pick one. Returns the chosen text or null. */
export async function rewriteFlow(store: Store, text: string, kind: TextKind, role?: Work): Promise<string | null> {
  const ai = await store.getAI();
  if (!ai) return null;
  const options = await store.run("Writing rewrites", () => rewrite(ai, text, kind, role));
  if (!options) return null;
  if (!options.length) {
    store.flash("No rewrite kept the original facts; try editing by hand", "info");
    return null;
  }
  const picked = await store.pickText("Rewrite (numbers must match the original)", [
    ...options.map((o) => ({ label: o.label, text: o.text })),
    { label: "Keep original", text },
  ]);
  return picked === null || picked === options.length ? null : options[picked]!.text;
}
