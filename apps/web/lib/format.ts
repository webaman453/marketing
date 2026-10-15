import { formatDistanceToNowStrict, format as fmt, parseISO } from "date-fns";

export { compact, humanize, money, moneyCompact, multiple, number, percent } from "@ashniva/shared";

export const shortDate = (iso: string) => fmt(parseISO(iso), "d MMM");
export const longDate = (iso: string) => fmt(parseISO(iso), "d MMM yyyy");
export const dateTime = (iso: string) => fmt(parseISO(iso), "d MMM yyyy, h:mm a");
export const timeAgo = (iso: string) => `${formatDistanceToNowStrict(parseISO(iso))} ago`;

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

const tokenFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** AI token counts: 100000 → "100K", 2500000 → "2.5M" */
export const tokenCount = (n: number) => tokenFmt.format(n);
