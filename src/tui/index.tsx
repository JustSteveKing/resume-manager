import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { load, RESUME_PATH } from "../store.ts";
import { App } from "./app.tsx";
import { closePreviewRenderer } from "./preview-render.ts";
import { StoreProvider } from "./store.tsx";

export async function runTui(path = RESUME_PATH) {
  const existed = await Bun.file(path).exists();
  const resume = await load(path);
  // Show the welcome screen when there's nothing to edit yet.
  const firstRun = !existed || (!resume.basics.name && !resume.work.length && !resume.projects.length);
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: false });
  await new Promise<void>((resolve) => {
    const quit = () => {
      renderer.destroy();
      // Close the Chrome kept warm for previews, then let the process exit.
      void closePreviewRenderer().finally(resolve);
    };
    createRoot(renderer).render(
      <StoreProvider initial={resume} path={path}>
        <App onQuit={quit} firstRun={firstRun} />
      </StoreProvider>,
    );
  });
}
