import { logger } from "@/lib/logger";

type Cleanup = () => void;

const cleanups = new Set<Cleanup>();

/**
 * Anything that holds payroll data in memory registers a cleanup here, so signing out
 * (manually, by idle timeout or by session expiry) always wipes it. Returns an unregister function.
 */
export function registerSessionCleanup(cleanup: Cleanup): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

/**
 * Wipes everything the dashboard holds in memory without signing out: cached rows, received
 * data, queued and failed transfers, the transfer log, and the open password gate.
 * It is the same list that runs when a session ends, so nothing can be missed by one of them.
 */
export function clearInMemoryData(): void {
  runSessionCleanup();
}

export function runSessionCleanup(): void {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      logger.error("A session cleanup step failed.");
    }
  }
}
