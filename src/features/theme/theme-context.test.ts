import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, readStoredTheme } from "./theme-context";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to the system theme and ignores junk", () => {
    expect(readStoredTheme()).toBe("system");
    localStorage.setItem("payroll-hub:theme", "neon");
    expect(readStoredTheme()).toBe("system");
  });

  it("reads a saved choice from the namespaced key", () => {
    localStorage.setItem("payroll-hub:theme", "light");
    expect(readStoredTheme()).toBe("light");
  });

  it("sets data-theme for a manual choice and clears it for system", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
