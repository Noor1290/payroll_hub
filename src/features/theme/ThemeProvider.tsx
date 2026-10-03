import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { preferenceStorage } from "@/lib/storage";
import {
  applyTheme,
  readStoredTheme,
  THEME_STORAGE_KEY,
  ThemeContext,
  type ResolvedTheme,
  type ThemeChoice,
  type ThemeContextValue,
} from "./theme-context";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function systemTheme(): ResolvedTheme {
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(readStoredTheme);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  useEffect(() => {
    const query = window.matchMedia(LIGHT_QUERY);
    const onChange = () => setSystem(query.matches ? "light" : "dark");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    if (next === "system") preferenceStorage.removeItem(THEME_STORAGE_KEY);
    else preferenceStorage.setItem(THEME_STORAGE_KEY, next);
  }, []);

  const resolved: ResolvedTheme = theme === "system" ? system : theme;

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolved,
      setTheme,
      toggle: () => setTheme(resolved === "dark" ? "light" : "dark"),
    }),
    [theme, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
