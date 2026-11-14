import { useEffect, useState, type RefObject } from "react";

/**
 * Full screen for one app's pane (the browser's Fullscreen API). The button switches both
 * ways; Esc is the browser's own way out and cannot be turned off, so the pane follows the
 * browser's `fullscreenchange` rather than keeping its own idea of whether it is full screen.
 */
export function useFullScreen(element: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const follow = () =>
      setActive(Boolean(element.current) && document.fullscreenElement === element.current);
    follow();
    document.addEventListener("fullscreenchange", follow);
    return () => document.removeEventListener("fullscreenchange", follow);
  }, [element]);

  const toggle = () => {
    const target = element.current;
    if (!target) return;
    if (document.fullscreenElement === target) {
      void document.exitFullscreen?.().catch(() => {});
    } else {
      void target.requestFullscreen?.().catch(() => {});
    }
  };

  return { active, toggle };
}

const DIALOG = '[role="dialog"], [role="alertdialog"]';

/**
 * While an app's pane is full screen, only that pane can be seen: the dashboard's own pop-ups
 * (the password prompt, "Allow this app to read…", the idle warning) open outside it and would
 * be invisible, leaving an app waiting on a question nobody can see. So full screen ends as soon
 * as one of them appears outside the full-screen element.
 */
export function useLeaveFullScreenForDialogs(): void {
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver((records) => {
      const full = document.fullscreenElement;
      if (!full) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const dialog = node.matches(DIALOG) ? node : node.querySelector(DIALOG);
          if (dialog && !full.contains(dialog)) {
            void document.exitFullscreen?.().catch(() => {});
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}
