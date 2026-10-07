// Shapes shared by every code host. GitHub (src/forges/github.ts) and GitLab (src/forges/gitlab.ts)
// both produce RepoData, so analysis, write-ups and evidence don't care where code lives.

export type Forge = "github" | "gitlab";

export interface RepoFacts {
  /** Where the repo lives. Missing means GitHub (data cached before GitLab support). */
  forge?: Forge;
  /** Host for self-hosted GitLab, e.g. "gitlab.example.com". */
  host?: string;
  /** The same project on another forge (a mirror), after merging accounts. */
  alsoOn?: string[];
  name: string;
  fullName: string;
  url: string;
  description?: string;
  homepage?: string;
  fork: boolean;
  archived: boolean;
  stars: number;
  forks: number;
  openIssues: number;
  language?: string;
  topics: string[];
  license?: string;
  createdAt: string;
  pushedAt: string;
  sizeKb: number;
  /** Bytes per language (only collected for detailed repos). */
  languages?: Record<string, number>;
  /** README text, truncated (only collected for detailed repos). */
  readme?: string;
  /** Dependency manifests by filename (only collected for detailed repos). */
  manifests?: Record<string, string>;
}

export interface RepoData {
  forge?: Forge;
  host?: string;
  /** The account's profile page, e.g. https://github.com/ada. */
  profileUrl?: string;
  user: {
    login: string;
    name?: string;
    bio?: string;
    blog?: string;
    company?: string;
    location?: string;
    followers: number;
    publicRepos: number;
    createdAt: string;
  };
  repos: RepoFacts[];
  collectedAt: string;
}

export interface CollectOptions {
  /** How many repos get the expensive detail pass (languages, README, manifests). */
  detailed?: number;
  /** Pick which repos get details; defaults to portfolio score with language diversity. */
  rank?: (repos: RepoFacts[]) => RepoFacts[];
  refresh?: boolean;
  onProgress?: (message: string) => void;
}

/** "GitHub", "GitLab", or the host for self-hosted GitLab. */
export function forgeLabel(r: { forge?: Forge; host?: string }): string {
  if ((r.forge ?? "github") === "github") return "GitHub";
  return !r.host || r.host === "gitlab.com" ? "GitLab" : r.host;
}
