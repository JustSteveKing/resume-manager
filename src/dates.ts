const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE_KEY = /(^date$|Date$)/;

/** Coerce loose date strings ("Mar 2021", "2021-03-04T00:00Z", "Present") to ISO 8601 partials. */
export function normaliseDate(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const s = input.trim();
  if (!s || /^(present|current|now|ongoing)$/i.test(s)) return undefined;

  const iso = s.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (iso) return [iso[1], iso[2], iso[3]].filter(Boolean).join("-");

  const monthYear = s.match(/^([a-z]{3,})\.?\s+(\d{4})$/i);
  if (monthYear) {
    const m = MONTHS.indexOf(monthYear[1]!.slice(0, 3).toLowerCase());
    if (m >= 0) return `${monthYear[2]}-${String(m + 1).padStart(2, "0")}`;
  }

  const slash = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[2]}-${slash[1]!.padStart(2, "0")}`;

  const year = s.match(/\b(\d{4})\b/);
  return year?.[1];
}

/** Return a copy with every `date` / `*Date` key normalised. */
export function normaliseDates<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = { ...obj };
  for (const key of Object.keys(out)) {
    if (DATE_KEY.test(key)) out[key] = normaliseDate(out[key]);
  }
  return out as T;
}

/** "2021-03" -> "Mar 2021", "2021" -> "2021". */
export function formatDate(iso?: string): string {
  if (!iso) return "";
  const [y, m] = iso.split("-");
  if (!m) return y!;
  const name = MONTHS[Number(m) - 1];
  return name ? `${name[0]!.toUpperCase()}${name.slice(1)} ${y}` : y!;
}

export function formatRange(start?: string, end?: string): string {
  if (!start && !end) return "";
  return `${formatDate(start)} – ${end ? formatDate(end) : "Present"}`;
}
