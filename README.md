# resume-manager

Build, maintain, tailor and export a [JSON Resume](https://jsonresume.org/schema), with web import, job tailoring and company research powered by [Tabstack](https://tabstack.ai).

`resume.json` is your full career record (gitignored; start from `examples/resume.example.json`). **Variants** turn it into short, targeted resumes; **tailoring** builds a variant for a specific job posting.

## Setup

```sh
bun install
bunx puppeteer browsers install chrome   # Bun skips postinstall, so fetch Chrome for PDF export
cp .env.example .env                     # add TABSTACK_API_KEY (import, tailor, refresh)
cp -r examples/variants variants         # optional starter variants
bun start                                # interactive TUI
```

## Commands

Everything is available in the TUI (`bun start`). For scripts and CI:

```sh
bun start validate [--strict]                 # exit 1 on errors (or warnings with --strict)
bun start export                              # full resume, last theme used in the TUI
bun start export --all --format pdf,html,json,text --ats
bun start export --variant devrel --theme sidebar --pages 2 --fit
bun start variants                            # list variants
bun start tailor <job-url> --write            # + --research (~$2), --base <variant>, --name <name>
bun start refresh [--yes]                     # re-run saved import sources
bun start skills [--add]                      # suggest skills found in your own resume
bun start help
```

## Features

### Editing
Add, edit, reorder, sort and delete entries in every JSON Resume section. Changes save straight away. Entries can carry **tags** (`api`, `leadership`, `devrel`) for variants to select on.

### Validate
- Schema validation.
- Content gaps: empty Skills (hurts ATS keyword matching), missing contact details, roles without dates or highlights.
- Ordering, with a one-step fix.
- Writing: highlights over 30 words, role summaries over 40, weak openers ("Responsible for…", "Helped…"), roles with no numbers, duplicate highlights.

### Suggest skills
Scans your resume for technologies and practices you mention but haven't listed under Skills, grouped (Languages, Frameworks, APIs & Architecture, Data, Cloud & DevOps, Practices).

### Import & refresh sources
Import from any URL (personal site, talks page, author page, GitHub). Tabstack extracts structured entries; you pick which to merge, with duplicates flagged. Save a URL as a **source** and **Refresh sources** later re-runs it and shows only new entries. That keeps talks and articles up to date.

### Variants
`variants/<name>.json` files, created in the TUI or by hand:

```jsonc
{
  "label": "Developer Relations",
  "tags": ["devrel"],                // keep tagged entries with these tags (untagged always kept)
  "excludeTags": ["internal"],
  "keywords": ["Technical writing", "Public speaking", "Laravel"],  // rank roles/highlights/talks
  "maxRoles": 6,                     // the rest become one-line "Earlier Career" entries
  "maxHighlights": 3,
  "maxProjects": 3,
  "maxPublications": 8,
  "earlierCareerBefore": "2019",     // roles ending before this are condensed
  "dropRoleSummaries": true,
  "blocks": ["summary", "experience", "publications", "skills", "earlier"],  // sections + order
  "basics": { "label": "Developer Advocate", "summary": "…" },
  "theme": "sidebar", "accent": "#0f766e", "paper": "A4",
  "targetPages": 2,
  "fit": true                        // auto-trim until the PDF fits targetPages
}
```

Auto-fit applies the least painful trims first (hide role summaries, then fewer highlights, talks, projects and full roles, alternating) and reports which it used.

### Tailor to a job
1. Tabstack extracts the posting: title, company, requirements and ATS keywords.
2. You get a **keyword coverage** report: which keywords your resume covers and which are missing.
3. It writes a variant ranked against those keywords (on top of an optional base variant), set to fit 2 pages.
4. Optional: a tailored headline, summary and cover letter (Tabstack `generate`, using only facts from your resume).
5. Optional: **company research** (Tabstack Research, fast mode, about $2 per run).

Files go to `variants/<name>.json` and `applications/<name>/` (`job.md`, `cover-letter.md`, `research.md`).

### Export
To `dist/`: PDF, standalone HTML, JSON Resume (variant applied, tool settings stripped) and plain text for ATS forms. Each PDF reports its **page count** and, optionally, an **ATS check**. The check extracts the PDF's text the way an applicant tracking system would and verifies that headings, roles, dates and contact details survive, in order.

## PDF themes

| Theme | Look |
| --- | --- |
| `classic` | Clean sans-serif, accent section rules |
| `editorial` | Serif, centred masthead, spaced capitals |
| `sidebar` | Two columns: contact, skills, education, languages on the left |
| `compact` | Dense, monospace accents; fits the most per page |
| `banner` | Bold colour header band |

Pick theme, accent (preset or custom hex) and paper size when exporting; the full resume remembers your last choice in `meta.pdf`. To add a theme, add a `Theme` to `src/export/themes.ts`: CSS using `var(--accent)`, plus an optional `sidebar` list of blocks. Keep heading `letter-spacing` at or below `0.06em`: wider tracking makes extracted text come out as "S U M M A R Y", which the ATS check catches.

## CI

`.github/workflows/resume.yml` runs tests, validates, and exports the full resume and every variant with the ATS check.

Your data stays out of git: `resume.json`, `variants/` and `applications/` are gitignored, and `examples/` holds a fictional resume and sample variants. To build your real resume in CI, add repository secrets `RESUME_JSON` (`base64 -i resume.json`) and optionally `RESUME_VARIANTS` (`tar czf - variants | base64`); without them CI builds the examples. Exported files are only uploaded as an artifact (and attached to a release on `v*` tags) when the repo is private.

## Layout

| Path | Purpose |
| --- | --- |
| `src/schema.ts` | JSON Resume as Zod (plus tags, saved sources). Single source for validation, editor fields and Tabstack schemas |
| `src/variants.ts` | Variant schema, storage, `applyVariant`, auto-fit steps |
| `src/job.ts` | Job extraction, tailoring, cover letter, company research |
| `src/keywords.ts` | Keyword matching, coverage, skill suggestions |
| `src/lint.ts` | Validation and writing checks |
| `src/sources.ts` | Saved import sources and refresh |
| `src/export/` | Renderers (`html.ts`, `text.ts`), `themes.ts`, `ats.ts`, export pipeline |
| `src/cli.ts` → `commands.ts` / `tui.ts` | Entry point, non-interactive commands, TUI |

Env: `RESUME_PATH` (`resume.json`), `RESUME_OUT_DIR` (`dist`), `RESUME_VARIANTS_DIR` (`variants`), `RESUME_APPLICATIONS_DIR` (`applications`), `TABSTACK_API_KEY`.

```sh
bun test
bun run typecheck
```
