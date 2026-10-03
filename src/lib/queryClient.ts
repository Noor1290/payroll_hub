import { QueryClient } from "@tanstack/react-query";
import { registerSessionCleanup } from "@/lib/sessionCleanup";
import { classifyDataError } from "@/lib/supabase/errors";
import { registerLockCleanup } from "@/lib/unlock";

/**
 * The query cache holds payroll figures, so it lives in memory only (no persister, ever)
 * and is emptied whenever the session ends.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Retrying only helps for blips; a paused project, a bad session or a schema mismatch won't fix itself.
      retry: (failureCount, error) =>
        failureCount < 1 && classifyDataError(error).kind === "unknown",
    },
  },
});

registerSessionCleanup(() => queryClient.clear());

/** Query keys that hold per-employee data shown behind the password gate. */
export const GATED_QUERY_KEYS = [["run-entries"], ["db"]] as const;

// When the password gate locks, the rows it was protecting leave memory, not just the screen.
registerLockCleanup(() => {
  for (const queryKey of GATED_QUERY_KEYS) {
    void queryClient.cancelQueries({ queryKey });
    queryClient.removeQueries({ queryKey });
  }
});
