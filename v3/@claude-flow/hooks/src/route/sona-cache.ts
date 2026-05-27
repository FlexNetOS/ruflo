/**
 * Concrete SonaCache implementation — ADR-132
 *
 * In-process, TTL-aware cache backed by a plain `Map`.  Designed for the
 * current iteration where a full AgentDB-backed implementation is deferred;
 * the interface matches `SonaCache` from simulative-planning-router.ts so a
 * future iter can swap the backing store without touching callers.
 *
 * Expiry strategy:
 *   - Lazy: expired entries are pruned on read (no background I/O at startup).
 *   - Sweeper: a `setInterval` every 60 s cleans up all stale entries to bound
 *     memory growth on long-running processes.  Callers can stop the sweeper
 *     via the returned `dispose()` handle.
 *
 * @module @claude-flow/hooks/route/sona-cache
 */

import type { SimulativePlanResult, SonaCache } from './simulative-planning-router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: SimulativePlanResult;
  expiresAt: number; // Unix ms timestamp
}

/** Extended SonaCache that also exposes a read path and lifecycle handle. */
export interface InProcessSonaCache extends SonaCache {
  /**
   * Retrieve a cached plan by key.
   * Returns null if the entry is absent or has expired (entry is deleted on
   * expiry — lazy eviction).
   */
  getShortTerm(key: string): SimulativePlanResult | null;

  /**
   * Stop the background sweeper interval, allowing the process to exit
   * cleanly.  Idempotent — safe to call multiple times.
   */
  dispose(): void;

  /** Current number of live (non-expired) entries.  Used in benchmarks. */
  readonly size: number;
}

// ---------------------------------------------------------------------------
// Sweeper interval (ms)
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an in-process, TTL-aware `SonaCache` implementation.
 *
 * The returned cache is safe for single-process use.  For multi-process or
 * distributed scenarios, a future iteration should return an AgentDB-backed
 * implementation implementing the same `SonaCache` interface.
 *
 * @example
 * ```ts
 * const cache = createInProcessSonaCache();
 *
 * await cache.storeShortTerm('task-42', planResult, { ttlSeconds: 300 });
 * const hit = cache.getShortTerm('task-42'); // SimulativePlanResult | null
 *
 * // On shutdown:
 * cache.dispose();
 * ```
 */
export function createInProcessSonaCache(): InProcessSonaCache {
  const store = new Map<string, CacheEntry>();

  // Background sweeper — clears fully-expired entries every 60 s.
  const sweeperId = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  }, SWEEP_INTERVAL_MS);

  // Allow the interval to be garbage-collected without blocking process exit.
  if (typeof sweeperId === 'object' && 'unref' in sweeperId) {
    // Node.js-specific: prevent the timer from keeping the event loop alive.
    (sweeperId as NodeJS.Timeout).unref();
  }

  let disposed = false;

  return {
    async storeShortTerm(
      key: string,
      value: SimulativePlanResult,
      opts: { ttlSeconds: number },
    ): Promise<void> {
      const expiresAt = Date.now() + opts.ttlSeconds * 1_000;
      store.set(key, { value, expiresAt });
    },

    getShortTerm(key: string): SimulativePlanResult | null {
      const entry = store.get(key);
      if (!entry) return null;

      if (entry.expiresAt <= Date.now()) {
        // Lazy eviction.
        store.delete(key);
        return null;
      }

      return entry.value;
    },

    dispose(): void {
      if (!disposed) {
        clearInterval(sweeperId);
        disposed = true;
      }
    },

    get size(): number {
      const now = Date.now();
      let count = 0;
      for (const entry of store.values()) {
        if (entry.expiresAt > now) count++;
      }
      return count;
    },
  };
}
