
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## This project

- `src/schema.ts` (Zod JSON Resume) is the single source of truth: adding a field there updates the editor (`fieldsFor`), the Tabstack extraction schema and validation. Renderers in `src/export/` must be updated by hand.
- Renderers take a `ResumeView` (`src/export/blocks.ts`): a resume after `applyVariant`, plus `earlierCareer` and `blockOrder`. Keep `html.ts` and `text.ts` block lists in sync; the ATS check compares them.
- Theme headings: keep `letter-spacing` ≤ 0.06em and avoid `font-variant: small-caps`; both break PDF text extraction. The ATS tests in `test/features.test.ts` render every theme.
- Tabstack Research costs ~$2 per run; always confirm before calling `researchCompany`.
- TypeScript 7: `tsconfig.json` needs `"types": ["bun"]`.
- TUI is OpenTUI + React (`src/tui/`). `Form` (`form.tsx`) is the generic field editor; views compose it with lists. Each view uses `useKeys(active, …)`, which skips while a modal is open or an editor owns input (`store.editing`). On screens containing a Form, don't bind view-level keys that Form uses (`e`, `x`, `j`, `k`, enter, space, arrows).
- `store.update(fn)` clones, mutates and saves; saving is blocked while a required field is blank (`saveBlockers`).
- TUI tests (`test/tui.test.tsx`) drive real key presses through `testRender`; wait ~25ms between keys (80ms after escape).
- GitHub scan (`src/github/`): keep analysis deterministic and AI optional. Anything the model writes must pass `isGrounded` (numbers must appear in the facts); add post-generation guards rather than relying on prompts. Tests inject a fake `GitHubClient` and `generate`; never hit GitHub or Tabstack from tests.
- Don't trigger Tabstack from render/debug harnesses: async work keeps running after the frame is captured.
- Duplicate detection (`src/sources.ts`) is shared by web import, refresh, GitHub and JSON Resume import. Same name/URL is only a duplicate with the same position and start year; otherwise `findSimilar` flags it for the user. Never silently skip a second role at the same company.
- Pass a human label to `store.update(fn, label)`; it's what undo reports ("Undid: delete Acme Corp"). Variant files are outside the store and not undoable.
- New actions belong in the command list in `src/tui/app.tsx` (searched by the palette). To make a view do something on open, use an `Intent` (`goTo(view, action, payload)`) and handle it in the view's `useEffect` keyed on `intent.n`.
- TUI tests navigate with the palette (`ui.open("Work")` types `: go to Work`), so they don't depend on nav order.
- AI features go through `AI` (`src/ai/index.ts`): Claude `claude-opus-5-5` via `client.beta.messages.parse` + `betaZodOutputFormat`, with `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), else Tabstack generate. Features take an `AI` parameter; tests pass `fakeAI` from `test/fixtures.ts`. Every AI output must pass `isGrounded` (`src/grounding.ts`) against the facts that were sent.
- Shared test helpers live in `test/fixtures.ts`. Never import from a `*.test.ts` file: Bun would re-run that suite inside the importer.
- `src/cli.ts` calls `applyEnvironment()` (`src/config.ts`) *before* dynamically importing everything else: modules read RESUME_* paths when imported. `config.ts` must not import other app modules.
- Tests isolate the user config, cache and applications via `test/setup.ts` (`RESUME_CONFIG_DIR` etc. in tmp). Never write to the real `~/.config/resume-manager` from tests or scripts; use `RESUME_CONFIG_DIR`.
- OpenTUI defines a global `window` (a requestAnimationFrame shim). PDF.js then takes its browser path and hangs on requestAnimationFrame, so page rasterising (`src/tui/preview-render.ts`) renders with `intent: "print"` and supplies Path2D/ImageData/DOMMatrix from @napi-rs/canvas. Don't switch it back to unpdf's renderPageAsImage.
- All paid calls go through the metered Tabstack client (`tabstack()`) or `ClaudeAI`, which check the budget and log spend. Don't construct SDK clients elsewhere for paid endpoints.
- GitHub and GitLab both produce `GitHubData`/`RepoFacts` (with `forge`/`host`); analysis and write-ups are forge-agnostic. Add forge-specific code in `src/forges/`, and use `forgeLabel`/`popularity` rather than hard-coding "GitHub". Inbox state keys for GitHub are bare repo names (pre-GitLab history); GitLab keys are `gitlab:<host>:<name>`.
- Run `bun test` and `bun run typecheck` after changes.
