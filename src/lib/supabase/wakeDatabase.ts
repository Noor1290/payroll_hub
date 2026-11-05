import { PING_FUNCTION } from "@/safety/keepAwake";
import { supabase } from "./client";

/**
 * Wakes the database while the user types a password (speed fix F7, Payroll\SPEED_CHECK): on
 * the free plan, the first request after a quiet spell takes 2 to 4 seconds, and this lets that
 * be paid while typing instead of on the first click. One call to public.keep_awake()
 * (migration 0015): it reads no table and answers true, and anyone may call it, signed in or
 * not. Nothing it answers is used. At most once every few minutes; a failure changes nothing.
 */
const EVERY_MS = 5 * 60_000;
let lastWoken = -Infinity;

export function wakeDatabase(now: number = Date.now()): void {
  if (!supabase || now - lastWoken < EVERY_MS) return;
  lastWoken = now;
  void Promise.resolve(supabase.rpc(PING_FUNCTION)).catch(() => {});
}

/** Tests only: as if the page had just been opened. */
export function forgetWakeDatabase(): void {
  lastWoken = -Infinity;
}
