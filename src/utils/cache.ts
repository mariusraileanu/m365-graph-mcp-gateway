/**
 * Lightweight in-memory TTL cache for Graph API read results.
 *
 * Designed for short-lived caching (5–60 s) to absorb repeated reads
 * during multi-turn LLM interactions without hitting Graph API rate limits.
 *
 * Features:
 * - Per-key TTL, configurable at set-time
 * - Max-entry eviction (oldest first) to bound memory
 * - Lazy expiry (checked on get; bulk sweep every N sets)
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number; // Date.now() + ttlMs
}

const DEFAULT_TTL_MS = 30_000; // 30 s
const MAX_ENTRIES = 500;
const SWEEP_INTERVAL = 50; // sweep every N sets

export class MicroCache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();
  private setCount = 0;

  /** Retrieve a cached value. Returns `undefined` if missing or expired. */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Store a value with an optional TTL (ms). */
  set(key: string, value: T, ttlMs: number = DEFAULT_TTL_MS): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });

    this.setCount += 1;
    if (this.setCount % SWEEP_INTERVAL === 0) this.sweep();

    // Evict oldest entries if we exceed the cap
    if (this.store.size > MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  /** Remove all expired entries. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  /** Number of entries (including possibly-expired ones). */
  get size(): number {
    return this.store.size;
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
    this.setCount = 0;
  }
}

/**
 * Shared cache instance for Graph API read results.
 * Key format: `<tool>:<primaryId>` (e.g., `email:AAMk...`, `thread:AAQk...`).
 */
export const graphCache = new MicroCache();
