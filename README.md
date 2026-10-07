# resume-manager

Build, maintain, tailor and export a [JSON Resume](https://jsonresume.org/schema), with web import, job tailoring and company research powered by [Tabstack](https://tabstack.ai).

`resume.json` is your full career record (gitignored; start from `examples/resume.example.json`). **Variants** turn it into short, targeted resumes; **tailoring** builds a variant for a specific job posting.

## Setup

```sh
bun install
bunx puppeteer browsers install chrome   # Bun skips postinstall, so fetch Chrome for PDF export
bun link                                 # installs the `cv` command
cv init ~/Documents/resume               # where your resume.json, variants and applications live
cv                                       # full-screen TUI, from any folder
cv doctor --live                         # check everything is set up (free checks)
```

API keys go in **Settings** (in the TUI) or `cv config key <tabstack|anthropic|github> <key>`. They're stored in `~/.config/resume-manager/config.json` (owner-only), never in the repo. A `.env` in your resume folder, or exported environment variables, also work and take precedence.

**Which folder is used:** `RESUME_HOME` if set, else the current folder if it has a `resume.json`, else the folder from `cv init`. `cv where` shows the paths in use. Inside the repo, `bun start` still works as before.

## The TUI

`cv` (or `bun start` inside the repo) opens a full-screen terminal app (built with [OpenTUI](https://github.com/anomalyco/opentui)):

```
╭ nav ─────────────╮╭─ Work (14) ─────────────────────────╮╭─ Senior Backend Engineer ─────────╮
│ Basics           ││ Acme Corp — Senio… Apr 2022 – Pres  ││ Name *      Acme Corp             │
│ Work          14 ││ Widgets Ltd — Sof… Sep 2018 – 2022  ││ Position    Senior Backend Eng…   │
│ Talks         17 ││ …                                   ││ Highlights  2 · Designed v2 R…    │
│ Preview          ││                                     ││                                   │
│ Variants       2 ││                                     ││ Name — Company or organisation    │
│ Issues        ▲2 ││ a add  d del  ⇧↑↓ move  s sort      ││ ↑↓ field  enter edit  esc back    │
╰──────────────────╯╰─────────────────────────────────────╯╰───────────────────────────────────╯
```

Every change saves immediately. The header shows `✔ saved`, or why it can't save yet (for example, a new entry still needs its required name).

- **Preview draws the real PDF in the terminal**: full resolution in Kitty, Ghostty, WezTerm and iTerm2 (Kitty graphics or Sixel), Unicode blocks anywhere else. `[ ]` turn pages, `c` cycles themes and `a` accents to try a look, `s` saves it, `t` switches to the plain-text (ATS) view. It re-renders as you edit, using a Chrome kept warm for the session.
- **Settings** (under SETUP): API keys, which AI writes, a monthly budget, preview mode, this month's spend, and the doctor's checks (`r` tests connections for free; `T` tests Tabstack, which costs one call).
- **Press `:` (or `ctrl+p`) and type** to do anything without memorising keys: "add work", "import json", "export", "sort", "scan github", "go to talks"…
- **`u` undoes any change** (edits, deletes, sorts, imports, merges, even replacing the whole resume); `U` redoes. The status bar shows what `u` will undo.
- **First run** (no resume yet) opens a welcome screen: import a JSON Resume, start from your GitHub, fill in your details, or explore with sample data.
- Empty sections (Awards, References…) are tucked under **+ more sections** in the nav until they have entries.

| Key | Action |
| --- | --- |
| `:` / `ctrl+p` | search every action |
| `u` / `U` | undo / redo (also `ctrl+z` / `ctrl+y`) |
| `tab` | switch between navigation and the main pane |
| `↑↓` / `j k` | move; `enter` / `→` open or edit; `esc` / `←` back |
| `a` / `d` / `⇧↑↓` | add, delete, reorder entries (and highlight/list items) |
| `s` | sort a dated section newest first; `g` suggest skills (Skills) |
| `x` | clear an optional field; `ctrl+s` save multi-line text |
| `r` | run (Import, Tailor, Sources, Export); `p` / `o` check / open PDF |
| `?` | all keys; `q` quit |

Views: **Preview** (plain-text render of the full resume or any variant; `o` opens the PDF), **Variants**, **Tailor to job**, **Import**, **Sources**, **Issues** (`enter` jumps to the problem or sorts), **Export**.

## Commands

Everything is available in the TUI. For scripts and CI:

```sh
cv validate [--strict]                        # exit 1 on errors (or warnings with --strict)
cv export                                     # full resume, last theme used in the TUI
cv export --all --format pdf,html,json,text --ats
cv export --variant devrel --theme sidebar --pages 2 --fit
cv variants                                   # list variants
cv tailor <job-url> --write                   # + --research (~$2), --base <variant>, --name <name>
cv refresh [--yes]                            # re-run saved import sources
cv skills [--add]                             # suggest skills found in your own resume
cv scan [--no-ai] [--top 8] [--yes]           # scan your GitHub and GitLab for skills and portfolio
cv github [user] / cv gitlab [user] [--gitlab-host <host>]   # one forge only
cv import <file|url|user> [--yes] [--replace]  # import a JSON Resume or LinkedIn export (dry run without --yes)
cv evidence [--all]                           # what backs up each skill
cv rewrite "<text>" [--summary]               # writing coach: 3 rewrites that keep your facts
cv apps [list|stats|status|followup]          # application tracker
cv prep <application>                         # interview prep from a tailored job
cv inbox [--yes]                              # new talks, repos and milestones since last time
cv help
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

### Spend and budget
Every Claude call is priced from its actual token usage (by the model that ran, since fallbacks can switch models) and logged in `.cache/spend.json`. Tabstack calls are counted; its SDK publishes no per-call prices, so Extract and Generate show as *unpriced*, and Research is priced at the documented ~$2 fast rate. Set a monthly cap with `cv config budget 10` or in Settings: a priced call that would exceed it is refused with a clear message. `cv spend` shows the month so far.

### AI writing help
The writing features use **Claude** (`claude-opus-5-5`) when `ANTHROPIC_API_KEY` or an `ant auth login` profile is present, and fall back to Tabstack `generate` otherwise (force one with `RESUME_AI=claude|tabstack`). Answers are cached by request in `.cache/ai/`, so repeating a request is free. Every feature has the same rule: **any number the model writes must already be in your facts**; anything else is dropped and reported.

- **Writing coach:** press `w` on a summary, title or highlight (or `bun start rewrite "…"`): shorter, result-first, and "did X, measured by Y, by doing Z" rewrites. Pick one or keep the original; `u` undoes.
- **Coach (achievement interviewer):** roles missing numbers or with long summaries are flagged. Answer 2-3 questions per role and your answers become quantified bullets to tick and add. Without an AI key it uses template questions and offers your answers as draft highlights.
- **Interview prep:** for an application (`i` in Applications, or `bun start prep <slug>`): likely questions, each mapped to resume highlights that answer it. Questions with no real evidence are marked as gaps to prepare a story for. Writes `applications/<slug>/interview-prep.md`.

### Evidence, consistency and first glance
- **Skill evidence map** (Evidence view, `bun start evidence`): for each listed skill, the roles, projects, talks and GitHub repos that back it up and when you last used it. Flags *unsupported* (listed, nothing shows it), *stale* (no evidence for 3+ years), *weak*, and *unlisted* skills you demonstrably have. Handles "Laravel 11", "Vue.js", "Domain-Driven Design (DDD)" and word forms ("Technical Writing" is backed by a "Technical Writer" role).
- **Consistency checks** (in Validate / Issues): present tense on finished roles, mixed British/American spelling, employment gaps of 6+ months, and the same title written two ways.
- **First glance** (with the ATS check on export): what the top third of page 1 shows (name, headline, contact, summary length, first role), and a warning if no experience makes it there.

### Applications
Tailoring a job creates `applications/<slug>/application.json`. Track status (draft → applied → interview → offer/rejected), follow-up dates (set automatically a week after applying; ⏰ when due), and notes. **What's working** compares response rates by variant, theme and keyword coverage once there are 3+ applications per group.

### Inbox
`bun start inbox` (or **Inbox → r**) re-runs your saved sources and GitHub, and suggests what's new: new talks and articles, new repos worth listing, and star milestones (with the popularity line on the matching project updated). The first run records a GitHub baseline. Accept or dismiss each one; dismissed suggestions don't return. Run it monthly with cron:

```
0 9 1 * * cd /path/to/resume-manager && bun start inbox
```

### LinkedIn
- **Import:** LinkedIn → Settings → Data privacy → *Get a copy of your data*. Point Import (or `bun start import`) at the `.zip` or the unzipped folder. Positions, education, skills, projects, publications, certifications, languages, honours and volunteering go through the normal importer (merge, duplicate checks, undo). Bullet lines in descriptions become highlights.
- **Export:** the `linkedin` format writes `<name>-linkedin.md`: headline, About and each role's description, sized to LinkedIn's limits (220 / 2,600 / 2,000 characters) with a warning where you're over.

### Import a JSON Resume
Bring in an existing resume from a file (`.json` or `.yaml`), a URL, a GitHub gist, or a [registry.jsonresume.org](https://registry.jsonresume.org) username. In the TUI: **Import → Source: JSON Resume**.

- **Normalised:** older schema fields are renamed (`website`→`url`, `company`→`name`, `gpa`→`score`, `picture`→`image`) and loose dates fixed ("March 2022"→`2022-03`, "Present" → no end date). YAML dates like `2020-01` stay intact.
- **Validated per entry:** one broken entry doesn't block the rest; invalid entries and unknown fields (e.g. `work[3].pinned`, `meta.theme`) are listed, not silently dropped.
- **Merge** (default) adds new entries and fills only *empty* basics, keeping yours. Same name and role = duplicate (skipped); same company with a different title or start = *possible duplicate* (unticked in the TUI, skipped by `--yes`), so a second role at one employer isn't lost.
- **Replace** overwrites everything after writing `resume.backup-<timestamp>.json` (gitignored), keeping your PDF settings and saved sources.

The CLI does a dry run unless you pass `--yes`.

### GitHub & GitLab scan
Builds evidence-backed Skills and Projects from your GitHub and GitLab (gitlab.com or self-hosted), using the GitHub and GitLab profiles in `resume.json` by default. Accounts are merged: a project on both (a mirror) counts once, keeping the more popular copy, and write-ups say where the stars are ("… on GitLab").

**GitLab notes:** works without a token for public projects, but GitLab then hides fork and archive flags, so forks can't be told apart from originals. Add a GitLab token in Settings (or `glab auth login`) for accurate results and private projects. For self-hosted GitLab, use your instance URL in the profile, or set the host in Settings / `cv config gitlab-host <url>`.

Steps:

1. **Collect** (GitHub REST API and GitLab API v4, cached 24h in `.cache/`): profile, every repo, and for the most relevant repos their languages, README and dependency manifests (`composer.json`, `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`…). GitHub auth: `GITHUB_TOKEN` or `gh auth token` (unauthenticated is limited to 60 requests/hour). GitLab auth: `GITLAB_TOKEN`, Settings, or `glab`.
2. **Analyse** (deterministic): languages ranked by recent primary-language repos, frameworks and tools detected from *actual dependencies* (not guessed), and a portfolio ranking with reasons (stars, forks, recency, presentation; forks, archives, scratch repos and self-declared deprecated repos are penalised).
3. **Write** (Tabstack generate, optional): a skills summary and resume-ready project write-ups, in batches that fit Tabstack's 20k-character limit. Responses are cached by request, so re-running unchanged facts is free.
4. **Ground**: any claim containing a number not present in the GitHub facts is dropped and listed in the report. Stat-only bullets ("Has 217 stars") are replaced by one accurate popularity line, and repo names are kept out of Skills.

Results go to `reports/repos-<user>.md` (gitignored). Merge projects and skills into your resume with `--yes`, or pick them individually in the TUI (**Repositories** view, `m`).

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
| `src/sources.ts` | Saved import sources and refresh; duplicate detection (`isDuplicate`, `findSimilar`) |
| `src/importer.ts` | JSON Resume import: read, normalise legacy fields, validate per entry, merge/replace |
| `src/repos/` | Repository scan: `types.ts` (shared shapes), `analyze.ts` (deterministic), `summarize.ts` (write-ups + grounding), `index.ts` (orchestration) |
| `src/forges/` | Collectors: `github.ts`, `gitlab.ts`; accounts from profiles and merging mirrors (`index.ts`) |
| `src/export/` | Renderers (`html.ts`, `text.ts`), `themes.ts`, `ats.ts`, export pipeline |
| `src/config.ts`, `src/doctor.ts`, `src/costs.ts` | User config and data folder, setup checks, spend ledger and budget |
| `src/cli.ts` | Entry point: resolves the data folder, then runs a command or the TUI |
| `src/cli/` | Commands, one file per area (`setup`, `resume`, `apply`, `grow`), dispatched from `index.ts`; options in `context.ts` |
| `src/tui/` | OpenTUI app (`app.tsx`, `form.tsx`, `views/`); `tui/commands.ts` is the palette's action list |

Env: `GITLAB_TOKEN`, `GITLAB_HOST` (self-hosted), `RESUME_HOME` (data folder), `RESUME_CONFIG_DIR` (`~/.config/resume-manager`), `RESUME_AI`, `GITHUB_TOKEN` (optional), `RESUME_CACHE_DIR` (`.cache`), `RESUME_REPORTS_DIR` (`reports`), `RESUME_PATH` (`resume.json`), `RESUME_OUT_DIR` (`dist`), `RESUME_VARIANTS_DIR` (`variants`), `RESUME_APPLICATIONS_DIR` (`applications`), `TABSTACK_API_KEY`.

```sh
bun test
bun run typecheck
```
