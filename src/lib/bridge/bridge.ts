import { useSyncExternalStore } from "react";
import { appOrigin, APPS, DASHBOARD_ID } from "@/config/apps.config";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { createStore } from "@/lib/store";
import { isUnlocked } from "@/lib/unlock";
import { BridgeHub, type AppHealth } from "./hub";
import type { RequestDataPayload, ResponseDataPayload, SendDataPayload } from "./protocol";

/** The one hub for this page, built from the app registry. */
export const bridge = new BridgeHub({
  selfId: DASHBOARD_ID,
  apps: APPS.map((app) => ({
    id: app.id,
    origin: appOrigin(app),
    protocolVersion: app.protocolVersion,
    accepts: app.accepts,
    produces: app.produces,
    active: app.status === "active",
  })),
});

export function useAppHealth(): Readonly<Record<string, AppHealth>> {
  return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
}

/** Data an app has sent to the dashboard and the user has not dealt with yet. Memory only. */
export interface IncomingBatch {
  id: string;
  appId: string;
  receivedAt: number;
  payload: SendDataPayload;
}

/** An app asking for saved data, waiting for the user to approve or deny. */
export interface DataRequest {
  id: string;
  appId: string;
  payload: RequestDataPayload;
  respond: (response: ResponseDataPayload) => void;
}

/**
 * How long a request may wait for the user. Shorter than the 120 seconds bridge.js waits, so
 * the app always gets a real answer from the dashboard instead of its own generic timeout.
 */
export const REQUEST_DEADLINE_MS = 100_000;

/** More than this waiting at once means something is misbehaving; refuse instead of piling up payroll data. */
const MAX_WAITING = 5;

export const incomingBatches = createStore<IncomingBatch[]>([]);
export const dataRequests = createStore<DataRequest[]>([]);

let sequence = 0;

bridge.setHandlers({
  onData(appId, payload) {
    if (incomingBatches.get().length >= MAX_WAITING) {
      return { ok: false, error: "The dashboard still has earlier data waiting to be handled." };
    }
    incomingBatches.set((current) => [
      ...current,
      { id: `batch-${++sequence}`, appId, receivedAt: Date.now(), payload },
    ]);
    return { ok: true };
  },
  onRequest: handleDataRequest,
});

/**
 * An app asked for saved data. The request waits for the user (who may first have to unlock
 * the password gate) and always settles: with the data, a refusal, or, at the deadline, an
 * explicit "locked" or "no answer" reply. It never leaves the app hanging.
 */
export function handleDataRequest(
  appId: string,
  payload: RequestDataPayload,
): Promise<ResponseDataPayload> {
  return new Promise<ResponseDataPayload>((resolve) => {
    if (dataRequests.get().length >= MAX_WAITING) {
      resolve({
        ok: false,
        code: "unavailable",
        error: "The dashboard has too many requests waiting.",
      });
      return;
    }
    const id = `request-${++sequence}`;
    const respond = (response: ResponseDataPayload) => {
      clearTimeout(deadline);
      dataRequests.set((list) => list.filter((request) => request.id !== id));
      resolve(response);
    };
    const deadline = setTimeout(() => {
      respond(
        isUnlocked()
          ? {
              ok: false,
              code: "timeout",
              error: "Nobody answered the request in the dashboard in time.",
            }
          : {
              ok: false,
              code: "locked",
              error:
                "The dashboard is locked. Confirm your password there to unlock it, then ask again.",
            },
      );
    }, REQUEST_DEADLINE_MS);
    dataRequests.set((current) => [...current, { id, appId, payload, respond }]);
  });
}

// Signing out wipes everything the bridge holds: queued sends, received data, open requests.
registerSessionCleanup(() => {
  bridge.clear();
  incomingBatches.set([]);
  for (const request of dataRequests.get()) {
    request.respond({
      ok: false,
      code: "unavailable",
      error: "The dashboard cleared its data or its user signed out. Ask again.",
    });
  }
});
