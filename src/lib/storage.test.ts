import { beforeEach, describe, expect, it } from "vitest";
import { createNamespacedStorage, STORAGE_PREFIX, storageKey } from "./storage";

describe("storageKey", () => {
  it("prefixes bare names and leaves prefixed ones alone", () => {
    expect(storageKey("theme")).toBe("payroll-hub:theme");
    expect(storageKey("payroll-hub:auth")).toBe("payroll-hub:auth");
  });
});

describe("createNamespacedStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("only ever writes namespaced keys", () => {
    const store = createNamespacedStorage(() => sessionStorage);
    store.setItem("auth", "token");
    store.setItem("payroll-hub:auth-code-verifier", "v");

    const keys = Object.keys(sessionStorage);
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.startsWith(STORAGE_PREFIX))).toBe(true);
    expect(store.getItem("auth")).toBe("token");
  });

  it("keeps the session out of localStorage", () => {
    const store = createNamespacedStorage(() => sessionStorage);
    store.setItem("auth", "token");
    expect(localStorage.length).toBe(0);
  });

  it("removes items", () => {
    const store = createNamespacedStorage(() => sessionStorage);
    store.setItem("auth", "token");
    store.removeItem("auth");
    expect(store.getItem("auth")).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("falls back to memory when storage is unavailable or throws", () => {
    const missing = createNamespacedStorage(() => undefined);
    missing.setItem("theme", "dark");
    expect(missing.getItem("theme")).toBe("dark");

    const blocked = createNamespacedStorage(() => {
      throw new Error("SecurityError");
    });
    blocked.setItem("theme", "light");
    expect(blocked.getItem("theme")).toBe("light");
    blocked.removeItem("theme");
    expect(blocked.getItem("theme")).toBeNull();
  });
});
