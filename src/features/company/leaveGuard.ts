import { APPS } from "@/config/apps.config";
import { bridge } from "@/lib/bridge/bridge";
import { createStore } from "@/lib/store";

/**
 * A change of company reloads every app frame, so the apps show the new company (rehearsal fix
 * F1). Before that, if an app said it holds changes not saved yet (bridge.js `setUnsaved`), the
 * user is asked first. Saves are still protected by the BRN check, whatever is answered here.
 */
export interface LeaveQuestion {
  /** The apps that hold unsaved changes, by name, in registry order. */
  apps: string[];
  /** The company shown now, which "Stay on" keeps. */
  stayOn: string;
  go: () => void;
}

/** The question being asked now, if any. Shown by LeaveQuestionDialog. */
export const leaveQuestion = createStore<LeaveQuestion | null>(null);

/** "A", "A and B", "A, B and C". */
function listOf(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The question's title, e.g. "Payroll System has unsaved changes." */
export function unsavedTitle(apps: string[]): string {
  return `${listOf(apps)} ${apps.length === 1 ? "has" : "have"} unsaved changes.`;
}

/**
 * Runs `go` (something that changes the company) straight away when no app holds unsaved
 * changes, or once the user agrees. `stayOn` is the company shown now; with none, nothing is
 * asked.
 */
export function askBeforeLeaving(stayOn: string | null, go: () => void): void {
  const unsaved = new Set(bridge.unsavedApps());
  const apps = APPS.filter((app) => unsaved.has(app.id)).map((app) => app.name);
  if (stayOn === null || apps.length === 0) go();
  else leaveQuestion.set({ apps, stayOn, go });
}
