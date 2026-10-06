import * as p from "@clack/prompts";
import { z } from "zod";
import { describePdf, mergeSkills } from "./commands.ts";
import { BLOCK_IDS, type BlockId } from "./export/blocks.ts";
import { safeColour } from "./export/html.ts";
import { exportResume, PdfRenderer, type Format, type PaperSize } from "./export/index.ts";
import { ACCENTS, THEMES, themeById, type Theme } from "./export/themes.ts";
import { extractJob, generateTailored, jobCoverage, researchCompany, saveApplication, tailorVariant, type JobPosting, type Tailored } from "./job.ts";
import { suggestSkills } from "./keywords.ts";
import { lint } from "./lint.ts";
import { Basics, Location, Profile, type Resume, type Source } from "./schema.ts";
import { fieldsFor, SECTIONS, sectionByKey, type Field, type Section } from "./sections.ts";
import { isDuplicate, refreshSources, removeSource, saveSource, sourceLabel } from "./sources.ts";
import { isSortedRecent, sortRecent } from "./sort.ts";
import { load, RESUME_PATH, save } from "./store.ts";
import { extractItems, extractObject, type Effort } from "./tabstack.ts";
import { deleteVariant, listVariants, loadVariant, saveVariant, Variant, variantPath, variantSlug } from "./variants.ts";

class Cancelled extends Error {}

// Unwrap a clack prompt, turning Ctrl+C / Esc into an exception we can catch per menu.
async function ask<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await prompt;
  if (p.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}

type Item = Record<string, any>;

// ---------- generic editors ----------

async function editFields(fields: Field[], current: Item = {}): Promise<Item> {
  const out: Item = { ...current };
  for (const f of fields) {
    const message = `${f.label}${f.required ? "" : " (optional)"}`;
    if (f.kind === "tags") {
      const value = await ask(
        p.text({
          message: `${message} — comma separated, used by variants`,
          initialValue: (current[f.key] as string[] | undefined)?.join(", ") ?? "",
          placeholder: "api, leadership, devrel",
        }),
      );
      out[f.key] = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      continue;
    }
    if (f.kind === "list") {
      const value = await ask(
        p.multiline({
          message: `${message} — one per line, Enter twice to finish`,
          initialValue: (current[f.key] as string[] | undefined)?.join("\n") ?? "",
          placeholder: f.hint,
        }),
      );
      out[f.key] = value.split("\n").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const prompt = f.kind === "multiline" ? p.multiline : p.text;
    const value = await ask(
      prompt({
        message: f.kind === "multiline" ? `${message} — Enter twice to finish` : message,
        initialValue: current[f.key] ?? "",
        placeholder: f.kind === "date" ? "YYYY-MM (blank for none / present)" : f.hint,
        validate: (v) => {
          const s = v?.trim() ?? "";
          if (f.required && !s) return `${f.label} is required`;
          if (f.kind === "date" && s && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) {
            return "Use YYYY, YYYY-MM or YYYY-MM-DD";
          }
        },
      }),
    );
    out[f.key] = value.trim() || undefined;
  }
  return out;
}

async function editItem(schema: z.ZodObject, fields: Field[], current?: Item): Promise<Item> {
  let draft = current ?? {};
  while (true) {
    draft = await editFields(fields, draft);
    const parsed = schema.safeParse(draft);
    if (parsed.success) return parsed.data;
    p.log.error(z.prettifyError(parsed.error));
  }
}

async function editList(
  label: string,
  items: Item[],
  schema: z.ZodObject,
  fields: Field[],
  title: (i: Item) => string,
  persist: () => Promise<void>,
  dated = false,
) {
  while (true) {
    const unsorted = dated && !isSortedRecent(items);
    const choice = await ask(
      p.select<string>({
        message: `${label} (${items.length})`,
        options: [
          ...items.map((item, i) => ({ value: String(i), label: title(item) || `(untitled #${i + 1})` })),
          { value: "add", label: "+ Add new" },
          ...(items.length > 1 ? [{ value: "move", label: "↕ Reorder" }] : []),
          ...(dated && items.length > 1
            ? [{ value: "sort", label: "⇅ Sort by date", hint: unsorted ? "newest first — currently out of order" : "already sorted" }]
            : []),
          { value: "back", label: "← Back" },
        ],
      }),
    );
    if (choice === "back") return;

    if (choice === "sort") {
      sortRecent(items);
      await persist();
      p.log.success(`${label} sorted newest first`);
      continue;
    }

    if (choice === "add") {
      items.push(await editItem(schema, fields));
      await persist();
      continue;
    }

    if (choice === "move") {
      const from = Number(await ask(p.select<string>({
        message: "Move which entry?",
        options: items.map((item, i) => ({ value: String(i), label: title(item) })),
      })));
      const to = Number(await ask(p.select<string>({
        message: "Move to position",
        options: items.map((_, i) => ({ value: String(i), label: `${i + 1}` })),
        initialValue: String(from),
      })));
      items.splice(to, 0, ...items.splice(from, 1));
      await persist();
      continue;
    }

    const index = Number(choice);
    const action = await ask(
      p.select({
        message: title(items[index]!),
        options: [
          { value: "edit", label: "Edit" },
          { value: "delete", label: "Delete" },
          { value: "back", label: "← Back" },
        ],
      }),
    );
    if (action === "edit") items[index] = await editItem(schema, fields, items[index]);
    if (action === "delete") {
      if (!(await ask(p.confirm({ message: `Delete "${title(items[index]!)}"?`, initialValue: false })))) continue;
      items.splice(index, 1);
    }
    if (action !== "back") await persist();
  }
}

// ---------- menus ----------

async function editBasics(r: Resume, persist: () => Promise<void>) {
  while (true) {
    const choice = await ask(
      p.select({
        message: "Basics",
        options: [
          { value: "details", label: "Details", hint: r.basics.name ?? "not set" },
          { value: "location", label: "Location", hint: r.basics.location?.city ?? "not set" },
          { value: "profiles", label: "Profiles", hint: `${r.basics.profiles?.length ?? 0}` },
          { value: "back", label: "← Back" },
        ],
      }),
    );
    if (choice === "back") return;
    if (choice === "details") {
      const { location, profiles, ...rest } = r.basics;
      r.basics = { ...(await editItem(Basics.omit({ location: true, profiles: true }), fieldsFor(Basics), rest)), location, profiles };
    }
    if (choice === "location") {
      r.basics.location = await editItem(Location, fieldsFor(Location), r.basics.location);
    }
    if (choice === "profiles") {
      r.basics.profiles ??= [];
      await editList("Profiles", r.basics.profiles, Profile, fieldsFor(Profile),
        (i) => [i.network, i.username ?? i.url].filter(Boolean).join(": "), persist);
    }
    await persist();
  }
}

async function editSections(r: Resume, persist: () => Promise<void>) {
  while (true) {
    const key = await ask(
      p.select<string>({
        message: "Which section?",
        options: [
          ...SECTIONS.map((s) => ({ value: s.key, label: s.label, hint: `${r[s.key].length}` })),
          { value: "back", label: "← Back" },
        ],
      }),
    );
    if (key === "back") return;
    const s = SECTIONS.find((x) => x.key === key)!;
    await editList(s.label, r[s.key] as Item[], s.schema, s.fields, s.title, persist, s.dated);
  }
}

async function importFromWeb(r: Resume, persist: () => Promise<void>) {
  const url = await ask(
    p.text({
      message: "URL to import from",
      placeholder: "https://example.com/about",
      validate: (v) => (URL.canParse(v ?? "") ? undefined : "Enter a full URL including https://"),
    }),
  );
  const target = await ask(
    p.select<string>({
      message: "What does this page contain?",
      options: [
        { value: "basics", label: "Profile / bio", hint: "name, title, summary, links" },
        ...SECTIONS.map((s) => ({ value: s.key, label: s.label })),
      ],
    }),
  );
  const effort = await ask(
    p.select<Effort>({
      message: "Fetch effort",
      initialValue: "standard",
      options: [
        { value: "min", label: "Min", hint: "static pages, fastest" },
        { value: "standard", label: "Standard", hint: "most sites" },
        { value: "max", label: "Max", hint: "JS-heavy apps, 15–60s" },
      ],
    }),
  );

  const spin = p.spinner();
  spin.start(`Extracting from ${new URL(url).hostname} with Tabstack`);

  if (target === "basics") {
    let found: Partial<Basics>;
    try {
      found = await extractObject(url, Basics, effort);
      spin.stop("Extraction complete");
    } catch (e) {
      spin.error("Extraction failed");
      throw e;
    }
    await mergeBasics(r, found);
    await offerSaveSource(r, { url, target, effort });
    return persist();
  }

  const s = SECTIONS.find((x) => x.key === target)!;
  let result: Awaited<ReturnType<typeof extractItems>>;
  try {
    result = await extractItems(url, s.schema, effort);
    spin.stop(`Found ${result.valid.length} ${s.label.toLowerCase()} entr${result.valid.length === 1 ? "y" : "ies"}`);
  } catch (e) {
    spin.error("Extraction failed");
    throw e;
  }
  if (result.invalid.length) {
    p.log.warn(`${result.invalid.length} entr${result.invalid.length === 1 ? "y" : "ies"} skipped (failed validation)`);
  }
  if (result.valid.length) await mergeItems(r, s, result.valid as Item[]);
  await offerSaveSource(r, { url, target, effort });
  await persist();
}

async function offerSaveSource(r: Resume, source: Source) {
  if (r.meta?.sources?.some((x) => x.url === source.url && x.target === source.target)) return;
  const keep = await ask(p.confirm({ message: "Save this URL as a source for \"Refresh sources\"?", initialValue: false }));
  if (keep) saveSource(r, { ...source, lastRun: new Date().toISOString() });
}

async function mergeItems(r: Resume, s: Section, found: Item[]) {
  const existing = r[s.key] as Item[];
  const options = found.map((item, i) => {
    const dupe = isDuplicate(s, existing, item);
    return { value: i, label: s.title(item), hint: dupe ? "already in resume" : undefined, dupe };
  });
  const picked = await ask(
    p.multiselect<number>({
      message: "Select entries to add",
      options,
      initialValues: options.filter((o) => !o.dupe).map((o) => o.value),
      required: false,
    }),
  );
  if (!picked.length) return p.log.info("Nothing added");

  const review = await ask(p.confirm({ message: "Review and edit each entry before adding?", initialValue: false }));
  const list = r[s.key] as Item[];
  for (const i of picked) {
    const item = found[i]!;
    if (review) p.log.step(s.title(item));
    list.push(review ? await editItem(s.schema, s.fields, item) : item);
  }
  p.log.success(`Added ${picked.length} to ${s.label}`);

  if (s.dated && !isSortedRecent(list) && (await ask(p.confirm({ message: `Sort ${s.label} newest first?` })))) {
    sortRecent(list);
  }
}

async function mergeBasics(r: Resume, found: Partial<Basics>) {
  const changes: { key: keyof Basics; label: string; hint: string }[] = [];
  for (const f of fieldsFor(Basics)) {
    const key = f.key as keyof Basics;
    const next = found[key];
    if (typeof next === "string" && next !== r.basics[key]) {
      changes.push({ key, label: `${f.label}: ${truncate(next)}`, hint: r.basics[key] ? "replaces existing" : "new" });
    }
  }
  if (found.location && Object.keys(found.location).length) {
    changes.push({ key: "location", label: `Location: ${Object.values(found.location).join(", ")}`, hint: "merge" });
  }
  const known = new Set(r.basics.profiles?.map((pr) => pr.url));
  const newProfiles = found.profiles?.filter((pr) => pr.url && !known.has(pr.url)) ?? [];
  if (newProfiles.length) {
    changes.push({ key: "profiles", label: `Profiles: ${newProfiles.map((pr) => pr.network ?? pr.url).join(", ")}`, hint: "append" });
  }
  if (!changes.length) return p.log.info("Nothing new found");

  const picked = await ask(
    p.multiselect<keyof Basics>({
      message: "Apply which fields?",
      options: changes.map((c) => ({ value: c.key, label: c.label, hint: c.hint })),
      initialValues: changes.filter((c) => c.hint !== "replaces existing").map((c) => c.key),
      required: false,
    }),
  );
  for (const key of picked) {
    if (key === "location") r.basics.location = { ...r.basics.location, ...found.location };
    else if (key === "profiles") r.basics.profiles = [...(r.basics.profiles ?? []), ...newProfiles];
    else (r.basics as any)[key] = found[key];
  }
  p.log.success(`Updated ${picked.length} field(s)`);
}

// ---------- validate ----------

async function validateMenu(r: Resume, persist: () => Promise<void>) {
  const issues = lint(r);
  if (!issues.length) return p.log.success("Valid JSON Resume, no issues");
  const icon = { error: "✖", warn: "▲", info: "·" } as const;
  for (const group of ["schema", "content", "order", "writing"] as const) {
    const items = issues.filter((i) => i.group === group);
    if (items.length) p.note(items.map((i) => `${icon[i.level]} ${i.message}`).join("\n"), group[0]!.toUpperCase() + group.slice(1));
  }

  const unsorted = issues.flatMap((i) => (i.unsorted ? [sectionByKey(i.unsorted)] : []));
  if (!unsorted.length) return;
  const names = unsorted.map((s) => s.label).join(", ");
  if (await ask(p.confirm({ message: `Sort ${names} newest first now?` }))) {
    unsorted.forEach((s) => sortRecent(r[s.key] as Item[]));
    await persist();
    p.log.success(`Sorted ${names}`);
  }
}

// ---------- skills ----------

async function skillsMenu(r: Resume, persist: () => Promise<void>) {
  const suggestions = suggestSkills(r);
  if (!suggestions.length) return p.log.info("No new skills found in your resume text");
  const picked = await ask(
    p.multiselect<string>({
      message: "Skills mentioned in your resume but missing from Skills",
      options: suggestions.flatMap((s) => s.keywords!.map((k) => ({ value: `${s.name}\u0000${k}`, label: k, hint: s.name }))),
      initialValues: suggestions.flatMap((s) => s.keywords!.map((k) => `${s.name}\u0000${k}`)),
      required: false,
    }),
  );
  if (!picked.length) return;
  const grouped = new Map<string, string[]>();
  for (const v of picked) {
    const [group, kw] = v.split("\u0000") as [string, string];
    grouped.set(group, [...(grouped.get(group) ?? []), kw]);
  }
  mergeSkills(r, [...grouped].map(([name, keywords]) => ({ name, keywords })));
  await persist();
  p.log.success(`Added ${picked.length} skills. Edit sections → Skills to rename or regroup.`);
}

// ---------- variants ----------

const csv = (v?: string[]) => v?.join(", ") ?? "";
const fromCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

async function optionalNumber(message: string, current?: number): Promise<number | undefined> {
  const v = await ask(
    p.text({
      message: `${message} (blank for no limit)`,
      initialValue: current?.toString() ?? "",
      validate: (x) => (!x?.trim() || /^\d+$/.test(x.trim()) ? undefined : "Enter a whole number"),
    }),
  );
  return v.trim() ? Number(v) : undefined;
}

async function editVariant(r: Resume, current: Variant = {}): Promise<Variant> {
  const knownTags = [...new Set(SECTIONS.flatMap((s) => (r[s.key] as Item[]).flatMap((i) => i.tags ?? [])))];
  const v: Variant = { ...current };
  v.label = (await ask(p.text({ message: "Label", initialValue: v.label ?? "", placeholder: "e.g. Developer Relations" }))) || undefined;
  v.description = (await ask(p.text({ message: "Description (optional)", initialValue: v.description ?? "" }))) || undefined;

  const tagHint = knownTags.length ? `known: ${knownTags.join(", ")}` : "tag entries via Edit sections first";
  v.tags = fromCsv(await ask(p.text({ message: `Include tags, comma separated (${tagHint})`, initialValue: csv(v.tags) })));
  v.excludeTags = fromCsv(await ask(p.text({ message: "Exclude tags, comma separated", initialValue: csv(v.excludeTags) })));
  v.keywords = fromCsv(
    await ask(p.text({ message: "Keywords to rank by, comma separated", initialValue: csv(v.keywords), placeholder: "Laravel, API design, DevRel" })),
  );

  v.maxRoles = await optionalNumber("Max full roles (others become Earlier Career)", v.maxRoles);
  v.maxHighlights = await optionalNumber("Max highlights per role", v.maxHighlights);
  v.maxProjects = await optionalNumber("Max projects", v.maxProjects);
  v.maxPublications = await optionalNumber("Max talks/articles", v.maxPublications);
  v.earlierCareerBefore =
    (await ask(
      p.text({
        message: "Condense roles that ended before (YYYY or YYYY-MM, blank for none)",
        initialValue: v.earlierCareerBefore ?? "",
        validate: (x) => (!x?.trim() || /^\d{4}(-\d{2})?$/.test(x.trim()) ? undefined : "Use YYYY or YYYY-MM"),
      }),
    )) || undefined;
  v.dropRoleSummaries = await ask(p.confirm({ message: "Hide role summaries when a role has highlights?", initialValue: v.dropRoleSummaries ?? false }));

  const blocks = await ask(
    p.multiselect<BlockId>({
      message: "Sections to show",
      options: BLOCK_IDS.filter((b) => b !== "contact").map((b) => ({ value: b, label: b })),
      initialValues: v.blocks ?? BLOCK_IDS.filter((b) => b !== "contact"),
    }),
  );
  v.blocks = blocks.length === BLOCK_IDS.length - 1 ? undefined : BLOCK_IDS.filter((b) => blocks.includes(b));

  const label = (await ask(p.text({ message: "Headline override (optional)", initialValue: v.basics?.label ?? "" }))) || undefined;
  const summary = (await ask(p.multiline({ message: "Summary override (optional) — Enter twice to finish", initialValue: v.basics?.summary ?? "" }))).trim() || undefined;
  v.basics = label || summary ? { label, summary } : undefined;

  const look = await pickLook({ theme: v.theme, accent: v.accent, paper: v.paper }, false);
  Object.assign(v, { theme: look.themes[0]?.id, accent: look.accent, paper: look.paper });
  v.targetPages = await optionalNumber("Target pages", v.targetPages ?? 2);
  v.fit = v.targetPages ? await ask(p.confirm({ message: "Auto-trim content to fit target pages?", initialValue: v.fit ?? true })) : undefined;
  return Variant.parse(v);
}

async function variantsMenu(r: Resume) {
  while (true) {
    const names = await listVariants();
    const choice = await ask(
      p.select<string>({
        message: `Variants (${names.length})`,
        options: [
          ...names.map((n) => ({ value: n, label: n })),
          { value: "\u0000new", label: "+ New variant" },
          { value: "\u0000back", label: "← Back" },
        ],
      }),
    );
    if (choice === "\u0000back") return;
    if (choice === "\u0000new") {
      const name = variantSlug(await ask(p.text({ message: "Variant name", placeholder: "devrel", validate: (x) => (x?.trim() ? undefined : "Required") })));
      if (names.includes(name)) {
        p.log.error(`Variant "${name}" already exists`);
        continue;
      }
      await saveVariant(name, await editVariant(r));
      p.log.success(`Saved ${variantPath(name)}`);
      continue;
    }

    const action = await ask(
      p.select({
        message: choice,
        options: [
          { value: "preview", label: "Preview", hint: "export PDF, report pages + ATS" },
          { value: "edit", label: "Edit" },
          { value: "copy", label: "Duplicate" },
          { value: "delete", label: "Delete" },
          { value: "back", label: "← Back" },
        ],
      }),
    );
    const v = await loadVariant(choice);
    if (action === "preview") await runExports(r, [{ name: choice, variant: v }], { formats: ["pdf"], ats: true });
    if (action === "edit") {
      await saveVariant(choice, await editVariant(r, v));
      p.log.success(`Saved ${variantPath(choice)}`);
    }
    if (action === "copy") {
      const name = variantSlug(await ask(p.text({ message: "New name", initialValue: `${choice}-copy` })));
      await saveVariant(name, v);
      p.log.success(`Saved ${variantPath(name)}`);
    }
    if (action === "delete" && (await ask(p.confirm({ message: `Delete ${variantPath(choice)}?`, initialValue: false })))) {
      await deleteVariant(choice);
      p.log.success("Deleted");
    }
  }
}

// ---------- tailor ----------

async function tailorMenu(r: Resume) {
  const url = await ask(
    p.text({
      message: "Job posting URL",
      validate: (v) => (URL.canParse(v ?? "") ? undefined : "Enter a full URL including https://"),
    }),
  );
  const spin = p.spinner();
  spin.start("Extracting job posting with Tabstack");
  let job: JobPosting;
  try {
    job = await extractJob(url);
    spin.stop(`${job.title ?? "Unknown role"} @ ${job.company ?? "unknown company"}`);
  } catch (e) {
    spin.error("Extraction failed");
    throw e;
  }

  const cov = jobCoverage(r, job);
  p.note(
    [`Covered: ${cov.covered.join(", ") || "none"}`, "", `Missing: ${cov.missing.join(", ") || "none"}`].join("\n"),
    `Keyword coverage ${Math.round(cov.ratio * 100)}%`,
  );
  if (cov.missing.length) {
    p.log.info("Missing keywords you genuinely have? Add them to highlights or Skills, then re-run.");
  }

  const names = await listVariants();
  const baseName = names.length
    ? await ask(
        p.select<string>({
          message: "Start from",
          options: [{ value: "", label: "Full resume" }, ...names.map((n) => ({ value: n, label: n }))],
        }),
      )
    : "";
  const variant = tailorVariant(job, url, baseName ? await loadVariant(baseName) : {});
  const name = variantSlug(
    await ask(p.text({ message: "Save variant as", initialValue: variantSlug([job.company, job.title].filter(Boolean).join(" ") || "tailored") })),
  );

  let tailored: Tailored | undefined;
  if (await ask(p.confirm({ message: "Write a tailored headline, summary and cover letter?", initialValue: true }))) {
    spin.start("Writing with Tabstack");
    try {
      tailored = await generateTailored(url, r, variant, job);
      spin.stop("Draft ready");
      p.note(`${tailored.headline}\n\n${tailored.summary}`, "Headline & summary");
      if (await ask(p.confirm({ message: "Use this headline and summary in the variant?" }))) {
        variant.basics = { label: tailored.headline, summary: tailored.summary };
      }
    } catch (e) {
      spin.error("Generation failed");
      p.log.error(e instanceof Error ? e.message : String(e));
    }
  }

  let research: Awaited<ReturnType<typeof researchCompany>> | undefined;
  if (await ask(p.confirm({ message: "Research the company? (Tabstack Research, about $2 per run)", initialValue: false }))) {
    spin.start("Researching");
    try {
      research = await researchCompany(job, (m) => spin.message(truncate(m, 70)));
      spin.stop("Research complete");
    } catch (e) {
      spin.error("Research failed");
      p.log.error(e instanceof Error ? e.message : String(e));
    }
  }

  await saveVariant(name, variant);
  const files = await saveApplication(name, { url, job, cov, tailored, research });
  p.note([variantPath(name), ...files].join("\n"), "Written");

  if (await ask(p.confirm({ message: "Export the tailored PDF now?" }))) {
    await runExports(r, [{ name, variant }], { formats: ["pdf", "text"], ats: true });
  }
}

// ---------- sources ----------

async function refreshMenu(r: Resume, persist: () => Promise<void>) {
  const sources = r.meta?.sources ?? [];
  if (!sources.length) return p.log.info('No saved sources yet. Import from web and choose "save as source".');

  const action = await ask(
    p.select({
      message: `Sources (${sources.length})`,
      options: [
        { value: "refresh", label: "Refresh all", hint: sources.map(sourceLabel).join(", ").slice(0, 60) },
        { value: "remove", label: "Remove sources" },
        { value: "back", label: "← Back" },
      ],
    }),
  );
  if (action === "back") return;
  if (action === "remove") {
    const drop = await ask(
      p.multiselect<number>({
        message: "Remove which?",
        options: sources.map((s, i) => ({ value: i, label: sourceLabel(s), hint: s.lastRun?.slice(0, 10) })),
        required: false,
      }),
    );
    drop.map((i) => sources[i]!).forEach((s) => removeSource(r, s));
    return persist();
  }

  const spin = p.spinner();
  spin.start("Refreshing");
  const results = await refreshSources(r, (s) => spin.message(`Fetching ${sourceLabel(s)}`));
  spin.stop("Refreshed");
  for (const res of results) {
    if (res.kind === "error") p.log.error(`${sourceLabel(res.source)}: ${res.error}`);
    if (res.kind === "basics") {
      p.log.step(sourceLabel(res.source));
      await mergeBasics(r, res.found);
    }
    if (res.kind === "items") {
      if (!res.fresh.length) {
        p.log.info(`${sourceLabel(res.source)}: nothing new`);
        continue;
      }
      p.log.step(`${sourceLabel(res.source)}: ${res.fresh.length} new`);
      await mergeItems(r, res.section, res.fresh);
    }
  }
  await persist();
}

// ---------- export ----------

interface Look {
  themes: Theme[];
  accent?: string;
  paper: PaperSize;
}

async function pickLook(last: { theme?: string; accent?: string; paper?: PaperSize }, allowAll = true): Promise<Look> {
  const themeId = await ask(
    p.select<string>({
      message: "PDF theme",
      initialValue: themeById(last.theme)?.id ?? THEMES[0]!.id,
      options: [
        ...THEMES.map((t) => ({ value: t.id, label: t.label, hint: t.description })),
        ...(allowAll ? [{ value: "all", label: "All themes", hint: "one PDF each, to compare" }] : []),
      ],
    }),
  );
  const themes = themeId === "all" ? THEMES : [themeById(themeId)!];

  let accent = await ask(
    p.select<string>({
      message: "Accent colour",
      initialValue: last.accent ?? "",
      options: [
        { value: "", label: "Theme default", hint: themes.length === 1 ? themes[0]!.accent : undefined },
        ...ACCENTS.map((a) => ({ value: a.value, label: a.label, hint: a.value })),
        ...(last.accent && !ACCENTS.some((a) => a.value === last.accent)
          ? [{ value: last.accent, label: "Last custom", hint: last.accent }]
          : []),
        { value: "custom", label: "Custom hex…" },
      ],
    }),
  );
  if (accent === "custom") {
    accent = await ask(
      p.text({ message: "Hex colour", placeholder: "#2b5797", validate: (v) => (safeColour(v) ? undefined : "Use #rgb or #rrggbb") }),
    );
  }

  const paper = await ask(
    p.select<PaperSize>({
      message: "Paper size",
      initialValue: last.paper ?? "A4",
      options: [{ value: "A4", label: "A4" }, { value: "Letter", label: "US Letter" }],
    }),
  );
  return { themes, accent: accent || undefined, paper };
}

type Target = { name?: string; variant?: Variant; look?: Look };

async function runExports(
  r: Resume,
  targets: Target[],
  opts: { formats: Format[]; ats?: boolean; targetPages?: number; fit?: boolean },
) {
  const renderer = new PdfRenderer();
  const spin = p.spinner();
  try {
    for (const t of targets) {
      spin.start(`Exporting ${t.name ?? "full resume"}`);
      const res = await exportResume(
        {
          resume: r, variant: t.variant, variantName: t.name, formats: opts.formats,
          themes: t.look?.themes, accent: t.look?.accent, paper: t.look?.paper,
          targetPages: opts.targetPages, fit: opts.fit, ats: opts.ats,
        },
        renderer,
      );
      spin.stop(`Exported ${t.name ?? "full resume"}`);
      const lines = [...res.files.filter((f) => !f.endsWith(".pdf")), ...res.pdfs.flatMap(describePdf)];
      p.note(lines.join("\n"), t.name ?? "Full resume");
      const over = res.pdfs.find((x) => x.overTarget);
      if (over && !over.fitted.length) p.log.warn("Over target pages. Enable auto-trim, or make a variant with tighter limits.");
      if (res.pdfs.some((x) => x.ats && !x.ats.ok)) {
        p.log.warn("ATS check failed: some text doesn't survive PDF extraction. Try another theme, or attach the .txt to forms.");
      }
    }
  } catch (e) {
    spin.error("Export failed");
    throw e;
  } finally {
    await renderer.close();
  }
}

async function exportMenu(r: Resume, persist: () => Promise<void>) {
  const names = await listVariants();
  const picked = names.length
    ? await ask(
        p.multiselect<string>({
          message: "What to export",
          options: [{ value: "", label: "Full resume" }, ...names.map((n) => ({ value: n, label: n, hint: "variant" }))],
          initialValues: [""],
        }),
      )
    : [""];

  const formats = await ask(
    p.multiselect<Format>({
      message: "Formats",
      initialValues: ["pdf"],
      options: [
        { value: "pdf", label: "PDF" },
        { value: "html", label: "HTML", hint: "standalone page for your site" },
        { value: "json", label: "JSON Resume", hint: "for themes and other tools" },
        { value: "text", label: "Plain text", hint: "for ATS paste-in forms" },
      ],
    }),
  );

  const targets: Target[] = [];
  for (const name of picked) {
    if (!name) {
      const look = formats.some((f) => f === "pdf" || f === "html") ? await pickLook(r.meta?.pdf ?? {}) : undefined;
      if (look) {
        // Remember theme/accent/paper for next time (and for `bun start export`).
        r.meta = { ...r.meta, pdf: { theme: look.themes.length === 1 ? look.themes[0]!.id : r.meta?.pdf?.theme, accent: look.accent, paper: look.paper } };
        await persist();
      }
      targets.push({ look });
    } else targets.push({ name, variant: await loadVariant(name) });
  }

  let targetPages: number | undefined;
  let fit: boolean | undefined;
  let ats = false;
  if (formats.includes("pdf")) {
    const pages = await ask(
      p.select<string>({
        message: "Page target",
        options: [
          { value: "", label: "Variant setting / none" },
          { value: "1", label: "1 page" },
          { value: "2", label: "2 pages" },
          { value: "3", label: "3 pages" },
        ],
      }),
    );
    targetPages = pages ? Number(pages) : undefined;
    if (targetPages) fit = await ask(p.confirm({ message: "Auto-trim content to fit?", initialValue: true }));
    ats = await ask(p.confirm({ message: "Run ATS text-extraction check?", initialValue: true }));
  }
  await runExports(r, targets, { formats, targetPages, fit, ats });
}

// ---------- main ----------

export async function runTui() {
  p.intro("resume-manager");
  const resume = await load();
  const persist = () => save(resume);
  p.log.info(`Using ${RESUME_PATH}${(await Bun.file(RESUME_PATH).exists()) ? "" : " (new file, created on first save)"}`);

  while (true) {
    let action: string;
    try {
      action = await ask(
        p.select({
          message: resume.basics.name ? `${resume.basics.name}'s resume` : "Your resume",
          options: [
            { value: "basics", label: "Edit basics", hint: "name, contact, summary, profiles" },
            { value: "sections", label: "Edit sections", hint: "work, projects, skills, tags…" },
            { value: "skills", label: "Suggest skills", hint: "from your own resume text" },
            { value: "import", label: "Import from web", hint: "Tabstack" },
            { value: "refresh", label: "Refresh sources", hint: `${resume.meta?.sources?.length ?? 0} saved` },
            { value: "tailor", label: "Tailor to a job", hint: "keyword coverage, variant, cover letter" },
            { value: "variants", label: "Variants", hint: "targeted, shorter resumes" },
            { value: "validate", label: "Validate", hint: "schema, content, writing" },
            { value: "export", label: "Export", hint: "PDF, HTML, JSON, text" },
            { value: "quit", label: "Quit" },
          ],
        }),
      );
    } catch (e) {
      if (e instanceof Cancelled) break;
      throw e;
    }
    if (action === "quit") break;

    try {
      if (action === "basics") await editBasics(resume, persist);
      if (action === "sections") await editSections(resume, persist);
      if (action === "skills") await skillsMenu(resume, persist);
      if (action === "import") await importFromWeb(resume, persist);
      if (action === "refresh") await refreshMenu(resume, persist);
      if (action === "tailor") await tailorMenu(resume);
      if (action === "variants") await variantsMenu(resume);
      if (action === "validate") await validateMenu(resume, persist);
      if (action === "export") await exportMenu(resume, persist);
    } catch (e) {
      if (e instanceof Cancelled) continue; // back to main menu
      p.log.error(e instanceof Error ? e.message : String(e));
    }
  }
  p.outro("Bye");
}

const truncate = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
