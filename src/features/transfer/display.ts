import { formatMoney } from "@/lib/format";

/** How a cell value is shown in the wizard's tables. Display only; the value itself is never changed. */
export function showValue(value: unknown, money: boolean): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return money ? formatMoney(value) : String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
