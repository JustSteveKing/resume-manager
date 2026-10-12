#!/usr/bin/env bun
import { applyEnvironment } from "./config.ts";

const args = Bun.argv.slice(2);

try {
  // Resolve the data folder and keys first: other modules read their paths when they're imported.
  const env = await applyEnvironment();
  if (args.length) {
    const { runCommand } = await import("./cli/index.ts");
    process.exitCode = await runCommand(args, env);
  } else {
    const { runTui } = await import("./tui/index.tsx");
    await runTui();
  }
} catch (e) {
  console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
