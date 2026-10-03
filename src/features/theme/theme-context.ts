import { createContext, useContext } from "react";
import { preferenceStorage } from "@/lib/storage";

export type ThemeChoice = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export interface ThemeContextValue {
  /** What the user picked. */
  theme: ThemeChoice;
  /** What is actually on screen. */
  resolved: ResolvedTheme;
  setTheme: (theme: ThemeChoice) => void;
  toggle: () => void;
}

export const THEME_STORAGE_KEY = "theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "dark" || value === "light";
}

export function readStoredTheme(): ThemeChoice {
  const stored = preferenceStorage.getItem(THEME_STORAGE_KEY);
  return isThemeChoice(stored) ? stored : "system";
}

/** Writes the choice to <html>. "system" removes the attribute so the CSS media query decides. */
export function applyTheme(theme: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>.");
  return value;
}
