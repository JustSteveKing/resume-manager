import type { Resume, Work } from "../schema.ts";

// Renderable blocks, in default order. Themes move some into a sidebar; variants can reorder or hide.
export const BLOCK_IDS = [
  "contact", "summary", "experience", "earlier", "projects", "skills", "publications",
  "education", "volunteer", "awards", "languages", "interests",
] as const;

export type BlockId = (typeof BLOCK_IDS)[number];

/** A resume prepared for rendering: possibly filtered by a variant, plus render-only extras. */
export type ResumeView = Resume & {
  /** Older roles shown as one-liners instead of full entries. */
  earlierCareer?: Work[];
  /** Block order (and visibility). Defaults to BLOCK_IDS. */
  blockOrder?: BlockId[];
};
