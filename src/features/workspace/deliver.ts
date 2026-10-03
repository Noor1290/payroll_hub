import { toast } from "sonner";
import { getApp } from "@/config/apps.config";
import {
  beginTransfer,
  finishTransfer,
  retainedTransfer,
  type TransferSource,
} from "@/features/transfer/transferLog";
import { bridge } from "@/lib/bridge/bridge";
import type { SendFailure, SendOutcome } from "@/lib/bridge/hub";
import type { SendDataPayload } from "@/lib/bridge/protocol";
import { formatCount } from "@/lib/format";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { isUnlocked } from "@/lib/unlock";

const WHY: Record<SendFailure, string> = {
  unavailable: "The app isn't loaded.",
  "not-ready": "The app didn't become ready in time.",
  timeout: "The app didn't confirm it received the data (timeout).",
  rejected: "The app refused the data.",
};

const LOCKED = "The dashboard is locked. Confirm your password, then send again.";

export function failureText(outcome: Extract<SendOutcome, { ok: false }>): string {
  if (outcome.reason === "rejected" && outcome.error) {
    return `The app refused the data: ${outcome.error}`;
  }
  return outcome.reason === "unavailable" && outcome.error ? outcome.error : WHY[outcome.reason];
}

/** Saves rows as a JSON file on the user's machine: the manual route when an app can't be reached. */
export function downloadJson(rows: unknown, fileName: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadName(payload: SendDataPayload): string {
  return `${payload.dataType}${payload.meta?.period ? `-${payload.meta.period}` : ""}.json`;
}

interface DeliverOptions {
  /** Where the rows came from, for the transfer log and the password gate. */
  source: TransferSource;
  /** Reuse the id of a failed attempt, so the app can recognise a duplicate. */
  retryId?: string;
  /** Show progress and the result as a toast. Off when the caller shows them itself. */
  notify?: boolean;
}

/**
 * The one way data leaves the dashboard for an app. It records the attempt in the transfer
 * log, sends through the bridge, and reports the result. A failed transfer keeps its data in
 * memory so it can be retried with the same message id.
 */
export async function deliver(
  appId: string,
  payload: SendDataPayload,
  { source, retryId, notify = true }: DeliverOptions,
): Promise<SendOutcome> {
  const id = retryId ?? crypto.randomUUID();
  const name = getApp(appId)?.name ?? appId;
  const count = `${formatCount(payload.rows.length)} ${payload.rows.length === 1 ? "row" : "rows"}`;
  const kept = { appId, payload, source };

  beginTransfer(id, appId, name, payload, source);
  const toastId = notify ? toast.loading(`Sending ${count} to ${name}`) : undefined;

  let outcome: SendOutcome;
  if (source.gated && !isUnlocked()) {
    // Rows from a saved run never leave while the password gate is locked.
    outcome = { ok: false, id, reason: "unavailable", error: LOCKED };
    finishTransfer(id, outcome, kept, "dashboard locked");
  } else {
    outcome = await bridge.send(appId, payload, { id });
    finishTransfer(id, outcome, kept);
  }

  if (!notify) return outcome;
  if (outcome.ok) {
    toast.success(`Delivered to ${name}`, {
      id: toastId,
      description: `${name} confirmed it received ${count}.`,
    });
  } else {
    toast.error(`Not delivered to ${name}`, {
      id: toastId,
      description: failureText(outcome),
      duration: Infinity,
      closeButton: true,
      action: {
        label: "Retry",
        onClick: () => {
          if (!retryTransfer(id)) {
            toast.error("That data is no longer in memory", {
              description: "Start the transfer again from its source.",
            });
          }
        },
      },
      cancel: {
        label: "Download JSON instead",
        onClick: () => downloadJson(payload.rows, downloadName(payload)),
      },
    });
  }
  return outcome;
}

/**
 * Tries a failed transfer again with the same message id. Resolves to null when its data is
 * no longer in memory (signed out, locked, or pushed out by newer failures).
 */
export function retryTransfer(id: string, notify = true): Promise<SendOutcome> | null {
  const kept = retainedTransfer(id);
  if (!kept) return null;
  return deliver(kept.appId, kept.payload, { source: kept.source, retryId: id, notify });
}

// Failed-delivery toasts offer Retry; they go when the session ends, along with the data.
registerSessionCleanup(() => toast.dismiss());
