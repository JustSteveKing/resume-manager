type Dated = { startDate?: string; endDate?: string; releaseDate?: string; date?: string };

const ONGOING = "9999";

// Entries with a start but no end are ongoing, so they sort as the most recent.
const end = (i: Dated) => i.endDate ?? (i.startDate ? ONGOING : (i.releaseDate ?? i.date ?? ""));
const start = (i: Dated) => i.startDate ?? i.releaseDate ?? i.date ?? "";

/** Reverse-chronological: latest end first, then latest start. Undated entries last. */
export function compareRecent(a: Dated, b: Dated): number {
  return end(b).localeCompare(end(a)) || start(b).localeCompare(start(a));
}

export function isSortedRecent(items: Dated[]): boolean {
  return items.every((item, i) => i === 0 || compareRecent(items[i - 1]!, item) <= 0);
}

/** Sort in place (stable, so ties keep their manual order). */
export function sortRecent<T extends Dated>(items: T[]): T[] {
  return items.sort(compareRecent);
}
