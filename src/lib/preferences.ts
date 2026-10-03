import { env } from "@/config/env";
import { preferenceStorage } from "@/lib/storage";
import { createStore } from "@/lib/store";

/** How long gated areas stay open after the password is confirmed. */
export const UNLOCK_MINUTES = { min: 1, max: 30, default: 10 } as const;

const UNLOCK_MINUTES_KEY = "unlock-minutes";

/** Whole minutes within the allowed range; anything unusable becomes the default. */
export function clampUnlockMinutes(value: unknown): number {
  const minutes = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return UNLOCK_MINUTES.default;
  return Math.min(UNLOCK_MINUTES.max, Math.max(UNLOCK_MINUTES.min, Math.round(minutes)));
}

/** A preference, not a secret: it is fine for this to live in localStorage. */
export const unlockMinutes = createStore<number>(
  clampUnlockMinutes(preferenceStorage.getItem(UNLOCK_MINUTES_KEY)),
);

export function setUnlockMinutes(value: unknown): number {
  const minutes = clampUnlockMinutes(value);
  preferenceStorage.setItem(UNLOCK_MINUTES_KEY, String(minutes));
  unlockMinutes.set(minutes);
  return minutes;
}

/** How often the Database page re-reads what it is showing. */
export const REFRESH_SECONDS = { min: 5, max: 120, default: 15 } as const;

const REFRESH_SECONDS_KEY = "database-refresh-seconds";

export function clampRefreshSeconds(value: unknown): number {
  const seconds = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return REFRESH_SECONDS.default;
  return Math.min(REFRESH_SECONDS.max, Math.max(REFRESH_SECONDS.min, Math.round(seconds)));
}

export const refreshSeconds = createStore<number>(
  clampRefreshSeconds(preferenceStorage.getItem(REFRESH_SECONDS_KEY)),
);

export function setRefreshSeconds(value: unknown): number {
  const seconds = clampRefreshSeconds(value);
  preferenceStorage.setItem(REFRESH_SECONDS_KEY, String(seconds));
  refreshSeconds.set(seconds);
  return seconds;
}

/**
 * Minutes without activity before the user is signed out. The build's
 * VITE_IDLE_TIMEOUT_MINUTES is the default; 0 there switches idle sign-out off for everyone,
 * and it then cannot be switched on from Settings.
 */
export const IDLE_MINUTES = { min: 1, max: 120, default: env.idleTimeoutMinutes } as const;
export const IDLE_SIGN_OUT_ENABLED = env.idleTimeoutMinutes > 0;

const IDLE_MINUTES_KEY = "idle-minutes";

export function clampIdleMinutes(value: unknown): number {
  const fallback = Math.min(IDLE_MINUTES.max, Math.max(IDLE_MINUTES.min, IDLE_MINUTES.default));
  const minutes = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return fallback;
  return Math.min(IDLE_MINUTES.max, Math.max(IDLE_MINUTES.min, Math.round(minutes)));
}

export const idleMinutes = createStore<number>(
  clampIdleMinutes(preferenceStorage.getItem(IDLE_MINUTES_KEY)),
);

export function setIdleMinutes(value: unknown): number {
  const minutes = clampIdleMinutes(value);
  preferenceStorage.setItem(IDLE_MINUTES_KEY, String(minutes));
  idleMinutes.set(minutes);
  return minutes;
}
