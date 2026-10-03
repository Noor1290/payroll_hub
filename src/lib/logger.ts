/* eslint-disable no-console */

/**
 * The only place allowed to write to the console.
 * Pass a fixed message and, at most, small non-sensitive facts (codes, counts, ids of apps).
 * Never pass payroll rows, message payloads, tokens or anything a user typed.
 */
type Meta = Record<string, string | number | boolean | null | undefined>;

export const logger = {
  warn(message: string, meta?: Meta): void {
    console.warn(`[payroll-hub] ${message}`, meta ?? "");
  },
  error(message: string, meta?: Meta): void {
    console.error(`[payroll-hub] ${message}`, meta ?? "");
  },
};
