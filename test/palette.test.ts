import { expect, test } from "bun:test";
import { searchCommands, type Command } from "../src/tui/commands.ts";

const cmd = (label: string, group: Command["group"] = "Edit", keywords?: string): Command => ({ id: label, label, group, keywords, run: () => {} });
const all = [cmd("Go to Work", "Go to"), cmd("Go to Skills", "Go to"), cmd("Add Work entry"), cmd("Export now with current settings", "Output", "pdf html"), cmd("Suggest skills from my resume", "Edit", "ats keywords")];

test("empty query keeps order", () => {
  expect(searchCommands(all, "").map((c) => c.label)).toEqual(all.map((c) => c.label));
});

test("every word must match; label beats keywords", () => {
  expect(searchCommands(all, "add work").map((c) => c.label)).toEqual(["Add Work entry"]);
  expect(searchCommands(all, "pdf").map((c) => c.label)).toEqual(["Export now with current settings"]);
  expect(searchCommands(all, "skills")[0]!.label).toBe("Go to Skills");
});

test("word-start matches rank above mid-word ones", () => {
  expect(searchCommands([cmd("Reword things"), cmd("Go to Work", "Go to")], "wor")[0]!.label).toBe("Go to Work");
});
