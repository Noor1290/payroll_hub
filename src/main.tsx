import "./zodConfig";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, readStoredTheme } from "./features/theme/theme-context";

// Apply a saved theme before the first paint so the page doesn't flash the other one.
applyTheme(readStoredTheme());

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
