/** Date helpers that work on plain YYYY-MM-DD strings in UTC, avoiding timezone drift. */

export const toISODate = (d: Date) => d.toISOString().slice(0, 10);

export const parseISODate = (s: string) => new Date(`${s}T00:00:00.000Z`);

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/** Inclusive number of days between two ISO dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseISODate(to).getTime() - parseISODate(from).getTime()) / 86_400_000) + 1;
}

/** Every date from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The equally long period immediately before the given range. */
export function previousPeriod(from: string, to: string) {
  const len = daysBetween(from, to);
  return { from: addDays(from, -len), to: addDays(from, -1) };
}
