import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { createStore } from "@/lib/store";
import type { ParsedFile } from "./parsePayroll";

/** Payroll data handed to the Import screen from somewhere other than a dropped file. */
export interface InboxItem {
  /** Shown where a file name would be, e.g. "From Payroll System, 14:32". */
  label: string;
  parsed: ParsedFile;
  /** "YYYY-MM" when the sender said which month it is. */
  month?: string;
}

/** Waiting items, in memory only. The Import screen takes them as soon as it is open. */
export const importInbox = createStore<InboxItem[]>([]);

registerSessionCleanup(() => importInbox.set([]));
