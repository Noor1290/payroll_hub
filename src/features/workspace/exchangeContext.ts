import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { createStore } from "@/lib/store";
import type { Viewer } from "@/lib/supabase/queries";
import type { Membership } from "@/lib/supabase/schemas";

/** Who is signed in and which company is selected, for handlers that run outside React. */
export interface ExchangeContext {
  viewer: Viewer;
  membership: Membership;
}

/** Set by BridgeDialogs once the session and the selected company have loaded; null until then. */
export const exchangeContext = createStore<ExchangeContext | null>(null);

/**
 * True while someone is signed in but the dashboard is still loading their companies: the moment
 * an app may ask too early. Set by BridgeDialogs. Signed out, or loaded, it is false.
 */
export const exchangeContextLoading = createStore(false);

registerSessionCleanup(() => {
  exchangeContext.set(null);
  exchangeContextLoading.set(false);
});

/**
 * How long an app's request or save waits for the dashboard to know who is signed in. After a
 * reload or a sign-in, an app's frame can be ready (and ask) before the selected company has
 * loaded (known issue 4). Shorter than the 8 seconds a save must be answered in.
 */
export const SIGN_IN_WAIT_MS = 5_000;

/**
 * While the dashboard is still loading which company is selected: a promise that resolves once it
 * has (or after `waitMs`). Otherwise null, so the caller goes on at once, in the same tick, as it
 * always did: signed out, or already loaded. Either way the handler then decides as before, so a
 * context that is still missing is refused as it always was.
 */
export function whenSignedIn(waitMs = SIGN_IN_WAIT_MS): Promise<void> | null {
  const settled = () => exchangeContext.get() !== null || !exchangeContextLoading.get();
  if (settled()) return null;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stopContext();
      stopLoading();
      resolve();
    };
    const check = () => {
      if (settled()) done();
    };
    const stopContext = exchangeContext.subscribe(check);
    const stopLoading = exchangeContextLoading.subscribe(check);
    const timer = setTimeout(done, waitMs);
  });
}
