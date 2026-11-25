/**
 * Shared provider result constants and helpers.
 */

export const CLAIM_STATUS = {
  CLAIMED: 'CLAIMED',
  NEEDS_USER: 'NEEDS_USER',
  FAILED: 'FAILED'
};

/**
 * Sleep for a specified duration, rejecting early if an AbortSignal fires.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('timeout'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('timeout'));
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Human-like randomized delay between minMs and maxMs (defaults to 1000–3000 ms).
 * @param {number} [minMs=1000]
 * @param {number} [maxMs=3000]
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function humanDelay(minMs = 1000, maxMs = 3000, signal) {
  const span = Math.max(0, maxMs - minMs);
  const waitMs = Math.floor(minMs + Math.random() * span);
  return delay(waitMs, signal);
}
