// Cache folder for API responses (GitHub, GitLab, AI answers, spend ledger). Set by cli.ts via RESUME_CACHE_DIR.
export const CACHE_DIR = process.env.RESUME_CACHE_DIR ?? ".cache";
