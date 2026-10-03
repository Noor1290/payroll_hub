/**
 * Browser storage helpers.
 *
 * Every site under the same GitHub Pages account shares one origin, and therefore one
 * localStorage/sessionStorage. All keys are namespaced so the hub never collides with the
 * embedded apps. Namespacing is tidiness, not isolation: those apps can still read these keys.
 *
 * Payroll values must never be written here. Only UI preferences and the auth session.
 */
export const STORAGE_PREFIX = "payroll-hub:";

export function storageKey(name: string): string {
  return name.startsWith(STORAGE_PREFIX) ? name : `${STORAGE_PREFIX}${name}`;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Wraps a Storage so every key is prefixed and failures (private mode, blocked storage,
 * quota) fall back to memory instead of throwing.
 */
export function createNamespacedStorage(resolve: () => Storage | undefined): KeyValueStorage {
  const memory = new Map<string, string>();

  const backing = (): Storage | undefined => {
    try {
      return resolve();
    } catch {
      return undefined;
    }
  };

  return {
    getItem(key) {
      const k = storageKey(key);
      try {
        const value = backing()?.getItem(k);
        if (value !== null && value !== undefined) return value;
      } catch {
        // fall through to memory
      }
      return memory.get(k) ?? null;
    },
    setItem(key, value) {
      const k = storageKey(key);
      try {
        const store = backing();
        if (store) {
          store.setItem(k, value);
          memory.delete(k);
          return;
        }
      } catch {
        // fall through to memory
      }
      memory.set(k, value);
    },
    removeItem(key) {
      const k = storageKey(key);
      memory.delete(k);
      try {
        backing()?.removeItem(k);
      } catch {
        // nothing else to clear
      }
    },
  };
}

/** UI preferences that should survive a browser restart (theme, sidebar state). */
export const preferenceStorage = createNamespacedStorage(() => globalThis.localStorage);

/** Per-browser-session data (the auth session). Gone when the tab or browser closes. */
export const sessionScopedStorage = createNamespacedStorage(() => globalThis.sessionStorage);
