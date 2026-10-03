const moneyFormat = new Intl.NumberFormat("en-MU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const countFormat = new Intl.NumberFormat("en-MU", { maximumFractionDigits: 0 });

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Mauritian rupees, e.g. "Rs 18,169.12". Display only: never feed the result back into data. */
export function formatMoney(value: number): string {
  return `Rs ${moneyFormat.format(value)}`;
}

export function formatCount(value: number): string {
  return countFormat.format(value);
}

/**
 * "2026-09-01" -> "September 2026". Parsed by hand: `new Date("2026-09-01")` is UTC midnight
 * and would show the previous month in timezones behind UTC.
 */
export function formatPeriod(period: string, style: "long" | "short" = "long"): string {
  const match = /^(\d{4})-(\d{2})/.exec(period);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return period;
  return `${style === "short" ? month.slice(0, 3) : month} ${match[1]}`;
}

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** A timestamp in the viewer's own timezone, e.g. "3 Oct 2026, 14:32". */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date);
}

/**
 * Adds money values without floating-point drift by summing whole cents.
 * This is a display total only; stored payroll figures are never changed.
 */
export function sumMoney(values: readonly number[]): number {
  let cents = 0;
  for (const value of values) cents += Math.round(value * 100);
  return cents / 100;
}
