import { PAYROLL_RESULT } from "@/config/apps.config";
import { handleDataRequest, registerDataType } from "@/lib/bridge/bridge";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { createStore } from "@/lib/store";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";
import { answerRequest } from "./deliver";

/**
 * How the dashboard handles each data type an app may ask for or send. Importing this file
 * registers the handlers with the bridge; the shell does that once (BridgeDialogs).
 *
 *  - payroll-result: unchanged. The user is asked first and the password gate must be open
 *    (the dialog in BridgeDialogs). The only addition is a row in the transfer log.
 */

/** Who is signed in and which company is selected, for handlers that run outside React. */
export interface ExchangeContext {
  viewer: Viewer;
  membership: Membership;
}
export const exchangeContext = createStore<ExchangeContext | null>(null);
registerSessionCleanup(() => exchangeContext.set(null));

registerDataType(PAYROLL_RESULT, {
  request: (appId, payload) =>
    answerRequest(appId, PAYROLL_RESULT, () => handleDataRequest(appId, payload)),
});
