import { StorageBusyError } from "@/lib/errors";
export { ApiError, StorageBusyError, apiFailure } from "@/lib/errors";
export { rateLimit } from "@/lib/rate-limit-storage";

export function isStorageBusy(error: unknown) {
  return error instanceof StorageBusyError;
}

/**
 * Re-runs an operation ONLY when a single Blob object lost its compare-and-swap
 * race repeatedly. Version conflicts, validation and availability errors are
 * never retried. A wall-clock budget keeps the request well below the function
 * timeout even when a caller passes a large attempt count.
 */
export async function retryStorageBusy<T>(operation: () => Promise<T>, attempts = 3, budgetMs = 6000): Promise<T> {
  const started = Date.now();
  const maxAttempts = Math.max(1, Math.min(attempts, 4));
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const delay = 120 + attempt * 180 + Math.floor(Math.random() * 120);
      if (!isStorageBusy(error) || attempt + 1 >= maxAttempts || Date.now() - started + delay > budgetMs) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
