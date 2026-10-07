import type { Resume, Skill } from "./schema.ts";

// Common alternative spellings, so "Postgres" in a job ad matches "PostgreSQL" in a resume.
const ALIASES: Record<string, string[]> = {
  javascript: ["JS"],
  typescript: ["TS"],
  postgresql: ["postgres"],
  kubernetes: ["k8s"],
  Go: ["golang"],
  "ci/cd": ["ci", "continuous integration", "continuous delivery"],
  "rest api": ["restful", "rest apis"],
  AWS: ["amazon web services"],
  GCP: ["google cloud"],
  "developer relations": ["devrel", "developer advocacy", "developer advocate"],
  "api design": ["api-first", "designing apis"],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const variants = (keyword: string): string[] => {
  const k = keyword.trim();
  const group = Object.entries(ALIASES).find(([canon, alts]) => same(canon, k) || alts.some((a) => same(a, k)));
  return group ? [group[0], ...group[1]] : [k];
};

// Boundaries that work for "C++", ".NET", "Node.js": not preceded/followed by a letter or digit.
// Terms of 3 chars or fewer ("Go", "AWS", "TS") match case-sensitively to avoid "go to market".
const patterns = new Map<string, RegExp>();
function pattern(keyword: string): RegExp {
  let re = patterns.get(keyword);
  if (!re) {
    const alts = variants(keyword).map((v) => (v.length <= 3 ? escape(v) : `(?i:${escape(v)})`));
    re = new RegExp(`(?<![A-Za-z0-9])(?:${alts.join("|")})(?![A-Za-z0-9])`);
    patterns.set(keyword, re);
  }
  return re;
}

export const mentions = (text: string, keyword: string) => pattern(keyword).test(text);

/** Number of distinct keywords mentioned in text. */
export const score = (text: string, keywords: string[]) =>
  keywords.reduce((n, k) => n + (mentions(text, k) ? 1 : 0), 0);

/** All human-readable text in a resume, for matching. */
export function resumeText(r: Resume): string {
  const parts: unknown[] = [r.basics.label, r.basics.summary];
  const walk = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) if (!/url|date|tags/i.test(k)) walk(x);
    }
  };
  [r.work, r.projects, r.skills, r.publications, r.education, r.volunteer, r.awards, r.certificates].forEach(walk);
  return parts.filter(Boolean).join("\n");
}

export function coverage(r: Resume, keywords: string[]) {
  const text = resumeText(r);
  // First spelling wins: ["Laravel", "laravel"] -> ["Laravel"].
  const unique = keywords.filter((k, i) => keywords.findIndex((x) => same(x, k)) === i);
  const covered = unique.filter((k) => mentions(text, k));
  const missing = unique.filter((k) => !mentions(text, k));
  return { covered, missing, ratio: unique.length ? covered.length / unique.length : 1 };
}

// Terms worth listing under Skills, grouped. Kept deliberately short and recognisable.
const TECH: Record<string, string[]> = {
  Languages: ["PHP", "Go", "TypeScript", "JavaScript", "Python", "Ruby", "Rust", "Java", "Kotlin", "C#", "SQL", "Bash"],
  Frameworks: ["Laravel", "Symfony", "Livewire", "Inertia", "Vue", "React", "Next.js", "Node.js", "Express", "Bun", "Django", "Rails", "Tailwind"],
  "APIs & Architecture": ["REST API", "GraphQL", "gRPC", "OpenAPI", "API design", "Webhooks", "OAuth", "Microservices", "Event-driven", "Domain-driven design", "MCP", "SaaS"],
  "Data": ["MySQL", "PostgreSQL", "Redis", "Elasticsearch", "MongoDB", "SQLite", "Kafka", "RabbitMQ"],
  "Cloud & DevOps": ["AWS", "GCP", "Azure", "Docker", "Kubernetes", "Terraform", "CI/CD", "GitHub Actions", "Laravel Cloud", "Forge", "Vapor", "Serverless", "Observability"],
  "Practices": ["TDD", "Pest", "PHPUnit", "Code review", "Technical writing", "Public speaking", "Mentoring", "Developer relations", "Developer experience", "Engineering management", "Hiring", "Roadmap planning", "Open source", "PSR standards"],
};

/** Skills mentioned in the resume text (or project keywords) that aren't yet in the Skills section. */
export function suggestSkills(r: Resume): Skill[] {
  const text = resumeText(r) + "\n" + r.projects.flatMap((p) => p.keywords ?? []).join("\n");
  const listed = r.skills.flatMap((s) => [s.name, ...(s.keywords ?? [])]).join("\n");
  return Object.entries(TECH)
    .map(([name, terms]) => ({ name, keywords: terms.filter((t) => mentions(text, t) && !mentions(listed, t)) }))
    .filter((s) => s.keywords.length);
}

/** Add suggested keywords into existing skill groups by name, creating groups as needed. */
export function mergeSkills(r: Resume, suggestions: Resume["skills"]) {
  for (const s of suggestions) {
    const existing = r.skills.find((x) => x.name.toLowerCase() === s.name.toLowerCase());
    if (existing) existing.keywords = [...new Set([...(existing.keywords ?? []), ...(s.keywords ?? [])])];
    else r.skills.push({ name: s.name, keywords: s.keywords });
  }
}
