import { toast } from "sonner";
import { getApp } from "@/config/apps.config";
import {
  beginExchange,
  beginTransfer,
  DATABASE,
  finishExchange,
  finishTransfer,
  retainedTransfer,
  type TransferSource,
} from "@/features/transfer/transferLog";
import { bridge } from "@/lib/bridge/bridge";
import type { SendFailure, SendOutcome } from "@/lib/bridge/hub";
import type { ReceivedPayload, ResponseDataPayload, SendDataPayload } from "@/lib/bridge/protocol";
import { formatCount, formatPeriod } from "@/lib/format";
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

/**
 * Answers an app's request for data and records the exchange in the transfer log: one row,
 * "waiting" until `answer` settles, then answered (with the number of rows) or refused (with a
 * fixed phrase for the reason). What is answered, and whether the user is asked first, is up
 * to `answer`; this adds no check of its own.
 */
export async function answerRequest(
  appId: string,
  dataType: string,
  answer: () => Promise<ResponseDataPayload>,
): Promise<ResponseDataPayload> {
  const id = crypto.randomUUID();
  beginExchange({
    id,
    kind: "request",
    from: DATABASE.name,
    toAppId: appId,
    toName: getApp(appId)?.name ?? appId,
    dataType,
  });

  let response: ResponseDataPayload;
  try {
    response = await answer();
  } catch {
    response = { ok: false, code: "unavailable", error: "The dashboard could not get the data." };
  }
  if (response.ok) {
    const period = response.meta?.period;
    finishExchange(id, {
      ok: true,
      rowCount: response.rows.length,
      from: period ? `${DATABASE.name}, ${formatPeriod(`${period}-01`)}` : undefined,
    });
  } else {
    finishExchange(id, { ok: false, code: response.code });
  }
  return response;
}

/**
 * Runs a save an app asked for, records it in the transfer log and tells the user with a
 * toast, whatever the outcome. The hub answers the app by itself after 8 seconds; the row and
 * the toast still report what really happened when `save` settles later than that.
 *
 * `describe` turns a successful result into the toast's text. It must not include payroll values.
 * `count` says how many rows the save stored, for the log; one unless told otherwise.
 */
export async function recordSave(
  appId: string,
  dataType: string,
  what: string,
  save: () => Promise<ReceivedPayload>,
  describe: (result: Record<string, unknown>) => string,
  count: (result: Record<string, unknown>) => number = () => 1,
): Promise<ReceivedPayload> {
  const id = crypto.randomUUID();
  const name = getApp(appId)?.name ?? appId;
  beginExchange({
    id,
    kind: "save",
    from: name,
    toAppId: DATABASE.id,
    toName: DATABASE.name,
    dataType,
  });

  let ack: ReceivedPayload;
  try {
    ack = await save();
  } catch {
    ack = { ok: false, code: "unavailable", error: "The dashboard could not save the data." };
  }
  if (ack.ok) {
    finishExchange(id, { ok: true, rowCount: count(ack.result ?? {}) });
    toast.success(describe(ack.result ?? {}), { description: `Saved from ${name}.` });
  } else {
    finishExchange(id, { ok: false, code: ack.code });
    toast.error(`${name} could not save ${what}`, { description: ack.error });
  }
  return ack;
}

// Failed-delivery toasts offer Retry; they go when the session ends, along with the data.
registerSessionCleanup(() => toast.dismiss());
