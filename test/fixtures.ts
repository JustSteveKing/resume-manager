// Shared test fixtures. Not a *.test.ts file, so importing it doesn't re-run other suites.
import type { z } from "zod";
import type { AI, AiRequest } from "../src/ai/index.ts";

/** Fake AI: answers each request with the next canned response, recording prompts. */
export function fakeAI(...responses: unknown[]): AI & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "claude",
    prompts,
    async json<T extends z.ZodType>(req: AiRequest<T>) {
      prompts.push(req.prompt);
      const next = responses.length > 1 ? responses.shift() : responses[0];
      return req.schema.parse(next);
    },
  };
}

// An old-style JSON Resume: v0 field names, loose dates, extra fields, one broken entry.
export const LEGACY = {
  basics: { name: "Grace Example", website: "https://grace.example", picture: "https://grace.example/me.png", location: "Bristol", "x-pronouns": "she/her" },
  work: [
    { company: "Acme Corp", position: "Lead Engineer", website: "https://acme.example", startDate: "March 2022", endDate: "Present", pinned: true },
    { company: "Widgets Ltd", position: "Engineer", startDate: "2018-09-01T00:00:00.000Z", endDate: "2022-02" },
    { position: "No company" },
  ],
  education: [{ institution: "Uni of Example", gpa: "3.8", startDate: 2010, endDate: 2014 }],
  skills: [{ name: "Backend", keywords: ["PHP", "Go"] }],
  publications: [{ name: "Talk", website: "https://talk.example", releaseDate: "Jun 2024" }],
  meta: { theme: "elegant" },
  customSection: [{ anything: true }],
};
