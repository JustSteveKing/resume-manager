#!/usr/bin/env bun
import * as p from "@clack/prompts";
import { runCommand } from "./commands.ts";
import { runTui } from "./tui.ts";

const args = Bun.argv.slice(2);

try {
  if (args.length) process.exitCode = await runCommand(args);
  else await runTui();
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (args.length) console.error(`✖ ${message}`);
  else p.log.error(message);
  process.exitCode = 1;
}
