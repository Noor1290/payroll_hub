import type { IncomingBatch } from "@/lib/bridge/bridge";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { createStore } from "@/lib/store";

/**
 * Data received from an app that the user chose to send on through the transfer wizard.
 * One batch at a time, in memory only, until it is discarded, replaced or the session ends.
 */
export const heldBatch = createStore<IncomingBatch | null>(null);

registerSessionCleanup(() => heldBatch.set(null));
