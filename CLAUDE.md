# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

resume-manager is a Bun + TypeScript CLI/TUI (`cv`) that builds, tailors and exports a JSON Resume. No web server, no build step: `src/cli.ts` runs directly.

## Commands

```sh
bun install
bunx puppeteer browsers install chrome   # Bun skips postinstall; PDF export and preview need Chrome
bun start                                # TUI (same as `cv` after `bun link`)
bun start <command> [opts]               # CLI, e.g. `bun start validate`, `bun start export --all --ats`
bun test                                 # all tests (preloads test/setup.ts via bunfig.toml)
bun test test/tui.test.tsx               # one file
bun test -t "pattern"                    # tests matching a name
bun run typecheck                        # tsc --noEmit (TypeScript 7)
```

CI (`.github/workflows/resume.yml`) runs typecheck, tests, `validate` and `export --all --ats` against `examples/` when no resume secrets are set.

## Bun

Use Bun, not Node: `bun <file>`, `bun test`, `bunx`, `bun:sqlite`, `Bun.file` over `node:fs` read/write, `Bun.$` over execa. Bun loads `.env` automatically (no dotenv). API docs: `node_modules/bun-types/docs/**.mdx`.

## Architecture

- **Data**: `resume.json` (full career record), `variants/<name>.json`, `applications/<slug>/` live in the user's data folder (`RESUME_HOME`, else cwd with a `resume.json`, else the `cv init` folder). Paths come from `RESUME_*` env vars set by `applyEnvironment()`. Keys/budget live in `~/.config/resume-manager/config.json`; caches, AI answers and the spend ledger in `.cache/`.
- **Flow**: `schema.ts` (Zod) → `store.ts` (load/save/prune) → `variants.ts` (`applyVariant` turns a resume + variant into a `ResumeView`, plus auto-fit trims) → `export/` (HTML/text renderers, themes, Puppeteer PDF, ATS text-extraction check).
- **Entry**: `src/cli.ts` → `cli/index.ts` (`runCommand`) with args, else `tui/index.tsx` (`runTui`).
- **TUI**: `tui/app.tsx` (layout, nav, command list), `tui/store.tsx` (state, undo/redo, saving), `tui/form.tsx` (generic editor), `tui/views/*` (one per screen).
- **Paid/AI**: `tabstack.ts` (metered Tabstack client), `ai/index.ts` (`AI` abstraction: local Ollama, or Tabstack generate when chosen), `costs.ts` (Tabstack spend ledger and budget; Tabstack is the only paid service), `grounding.ts` (`isGrounded`).
- **Features**: `job.ts` (tailoring, cover letter, research), `keywords.ts`, `lint.ts` + `consistency.ts` (Issues/validate), `evidence.ts`, `importer.ts` + `linkedin.ts` + `sources.ts` (imports and dedupe), `repos/` + `forges/` (GitHub/GitLab scan), `inbox.ts`, `applications.ts`.

## This project

- `src/schema.ts` (Zod JSON Resume) is the single source of truth: adding a field there updates the editor (`fieldsFor`), the Tabstack extraction schema and validation. Renderers in `src/export/` must be updated by hand.
- Renderers take a `ResumeView` (`src/export/blocks.ts`): a resume after `applyVariant`, plus `earlierCareer` and `blockOrder`. Keep `html.ts` and `text.ts` block lists in sync; the ATS check compares them.
- Theme headings: keep `letter-spacing` ≤ 0.06em and avoid `font-variant: small-caps`; both break PDF text extraction. The ATS tests in `test/features.test.ts` render every theme.
- Tabstack Research costs ~$2 per run; always confirm before calling `researchCompany`.
- TypeScript 7: `tsconfig.json` needs `"types": ["bun"]`.
- TUI is OpenTUI + React (`src/tui/`). `Form` (`form.tsx`) is the generic field editor; views compose it with lists. Each view uses `useKeys(active, …)`, which skips while a modal is open or an editor owns input (`store.editing`). On screens containing a Form, don't bind view-level keys that Form uses (`e`, `x`, `j`, `k`, enter, space, arrows).
- `store.update(fn)` clones, mutates and saves; saving is blocked while a required field is blank (`saveBlockers`).
- TUI tests (`test/tui.test.tsx`) drive real key presses through `testRender`; wait ~25ms between keys (80ms after escape).
- Repository scan (`src/repos/`, collectors in `src/forges/`): keep analysis deterministic and AI optional. Anything the model writes must pass `isGrounded` (numbers must appear in the facts); add post-generation guards rather than relying on prompts. Tests inject a fake `GitHubClient` and `generate`; never hit GitHub or Tabstack from tests.
- Don't trigger Tabstack from render/debug harnesses: async work keeps running after the frame is captured.
- Duplicate detection (`src/sources.ts`) is shared by web import, refresh, GitHub and JSON Resume import. Same name/URL is only a duplicate with the same position and start year; otherwise `findSimilar` flags it for the user. Never silently skip a second role at the same company.
- Pass a human label to `store.update(fn, label)`; it's what undo reports ("Undid: delete Acme Corp"). Variant files are outside the store and not undoable.
- New actions belong in the command list in `src/tui/app.tsx` (searched by the palette). To make a view do something on open, use an `Intent` (`goTo(view, action, payload)`) and handle it in the view's `useEffect` keyed on `intent.n`.
- TUI tests navigate with the palette (`ui.open("Work")` types `: go to Work`), so they don't depend on nav order.
- AI features go through `AI` (`src/ai/index.ts`): a local Ollama model (`qwen3:8b`, `/api/chat` with the Zod schema as `format`), or Tabstack generate only when chosen (`RESUME_AI=tabstack`). No cloud LLMs besides Tabstack: don't add Claude/OpenAI providers or fall back to a cloud model. `getAI` throws `NoAIError` when no AI is available (Ollama not running), so callers with a fallback catch only that; a present-but-broken Ollama throws a plain error. Features take an `AI` parameter; tests pass `fakeAI` from `test/fixtures.ts`. Every AI output must pass `isGrounded` (`src/grounding.ts`) against the facts that were sent.
- Shared test helpers live in `test/fixtures.ts`. Never import from a `*.test.ts` file: Bun would re-run that suite inside the importer.
- `src/cli.ts` calls `applyEnvironment()` (`src/config.ts`) *before* dynamically importing everything else: modules read RESUME_* paths when imported. `config.ts` must not import other app modules.
- Tests isolate the user config, cache and applications via `test/setup.ts` (`RESUME_CONFIG_DIR` etc. in tmp), and point `OLLAMA_HOST` at a closed port so a local Ollama doesn't change which AI tests get. Never write to the real `~/.config/resume-manager` from tests or scripts; use `RESUME_CONFIG_DIR`.
- OpenTUI defines a global `window` (a requestAnimationFrame shim). PDF.js then takes its browser path and hangs on requestAnimationFrame, so page rasterising (`src/tui/preview-render.ts`) renders with `intent: "print"` and supplies Path2D/ImageData/DOMMatrix from @napi-rs/canvas. Don't switch it back to unpdf's renderPageAsImage.
- All paid calls go through the metered Tabstack client (`tabstack()`), which checks the budget and logs spend. `loadConfig` and the ledger throw (`ConfigError`/`LedgerError`) on a file that exists but doesn't parse; never treat it as empty, or the next save overwrites it. Don't construct SDK clients elsewhere for paid endpoints.
- GitHub and GitLab both produce `RepoData`/`RepoFacts` (`src/repos/types.ts`) (with `forge`/`host`); analysis and write-ups are forge-agnostic. Add forge-specific code in `src/forges/`, and use `forgeLabel`/`popularity` rather than hard-coding "GitHub". Inbox state keys for GitHub are bare repo names (pre-GitLab history); GitLab keys are `gitlab:<host>:<name>`.
- CLI commands live in `src/cli/<area>.ts` as `cmdX(ctx)` functions registered in `src/cli/index.ts`; add new options to `OPTIONS` in `src/cli/context.ts`. (`src/tui/commands.ts` is the TUI palette, not the CLI.)
- Dependencies are pinned to exact versions (OpenTUI is pre-1.0). Upgrade one at a time and re-run the TUI and preview tests.
- Settings TUI tests select rows by position (Tabstack budget is the 4th row): update `test/tui.test.tsx` when adding rows above it.
- Run `bun test` and `bun run typecheck` after changes.
