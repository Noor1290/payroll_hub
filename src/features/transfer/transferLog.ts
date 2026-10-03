import type { SendOutcome } from "@/lib/bridge/hub";
import type { SendDataPayload } from "@/lib/bridge/protocol";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { createStore } from "@/lib/store";
import { registerLockCleanup } from "@/lib/unlock";

/**
 * A record of what was sent where during this session.
 *
 * Memory only, and it holds NO payroll values: just who, when, how many rows and what happened.
 * The payload of a failed transfer is kept separately (also in memory) so it can be retried,
 * and is dropped when the session ends, or, for data that came from a saved run, when the
 * password gate locks.
 */
export interface TransferLogEntry {
  /** The bridge message id. A retry reuses it, so the app can spot a duplicate. */
  id: string;
  /** When the transfer was first started (epoch milliseconds). */
  at: number;
  /** Where the data came from, e.g. "Payroll System" or "Database, September 2026". */
  from: string;
  toAppId: string;
  toName: string;
  rowCount: number;
  dataType: string;
  status: "sending" | "delivered" | "failed";
  /** A fixed phrase explaining a failure. Never text supplied by an app. */
  reason: string | null;
  attempts: number;
  /** Whether the data is still in memory to try again. */
  canRetry: boolean;
}

export interface TransferSource {
  /** Shown in the log's "from" column. Must not contain payroll values. */
  label: string;
  /** True when the rows came from a saved run, i.e. from behind the password gate. */
  gated: boolean;
}

interface Retained {
  appId: string;
  payload: SendDataPayload;
  source: TransferSource;
}

const MAX_ENTRIES = 200;
/** Failed payloads kept for Retry. Older ones are let go. */
const MAX_RETAINED = 5;

export const transferLog = createStore<TransferLogEntry[]>([]);
const retained = new Map<string, Retained>();

const REASONS: Record<Extract<SendOutcome, { ok: false }>["reason"], string> = {
  unavailable: "app not loaded",
  "not-ready": "app not ready (timeout)",
  timeout: "no confirmation from the app (timeout)",
  rejected: "refused by the app",
};

function syncRetryFlags(): void {
  transferLog.set((entries) =>
    entries.map((entry) =>
      entry.canRetry === retained.has(entry.id)
        ? entry
        : { ...entry, canRetry: retained.has(entry.id) },
    ),
  );
}

/** Records that a transfer is starting (or being retried). */
export function beginTransfer(
  id: string,
  appId: string,
  appName: string,
  payload: SendDataPayload,
  source: TransferSource,
): void {
  const existing = transferLog.get().find((entry) => entry.id === id);
  if (existing) {
    transferLog.set((entries) =>
      entries.map((entry) =>
        entry.id === id
          ? { ...entry, status: "sending", reason: null, attempts: entry.attempts + 1 }
          : entry,
      ),
    );
    return;
  }
  transferLog.set((entries) =>
    [
      {
        id,
        at: Date.now(),
        from: source.label,
        toAppId: appId,
        toName: appName,
        rowCount: payload.rows.length,
        dataType: payload.dataType,
        status: "sending" as const,
        reason: null,
        attempts: 1,
        canRetry: false,
      },
      ...entries,
    ].slice(0, MAX_ENTRIES),
  );
}

/** Records how a transfer ended. On failure the payload is kept so it can be retried. */
export function finishTransfer(
  id: string,
  outcome: SendOutcome,
  kept: Retained,
  reasonOverride?: string,
): void {
  if (outcome.ok) {
    retained.delete(id);
  } else {
    retained.delete(id);
    retained.set(id, kept);
    while (retained.size > MAX_RETAINED) retained.delete(retained.keys().next().value!);
  }
  transferLog.set((entries) =>
    entries.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            status: outcome.ok ? "delivered" : "failed",
            reason: outcome.ok ? null : (reasonOverride ?? REASONS[outcome.reason]),
          }
        : entry,
    ),
  );
  syncRetryFlags();
}

/** The data of a failed transfer, if it is still in memory. */
export function retainedTransfer(id: string): Retained | undefined {
  return retained.get(id);
}

/** Empties the log and lets go of every kept payload. */
export function clearTransferLog(): void {
  retained.clear();
  transferLog.set([]);
}

// The session ended: nothing about it stays.
registerSessionCleanup(clearTransferLog);

// The password gate locked: data that came from behind it can no longer be retried.
registerLockCleanup(() => {
  for (const [id, entry] of retained) if (entry.source.gated) retained.delete(id);
  syncRetryFlags();
});
