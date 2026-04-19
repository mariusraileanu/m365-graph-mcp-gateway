import { isLoggedIn } from '../auth/index.js';
import { graphCache } from '../utils/cache.js';

/** Default TTL for Graph API read-through cache entries (30 s). */
export const GRAPH_CACHE_TTL_MS = 30_000;

export async function requireLoggedIn(): Promise<void> {
  if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
}

export async function readThroughGraphCache<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const cached = graphCache.get(key) as T | undefined;
  if (cached !== undefined) return cached;

  const value = await loader();
  graphCache.set(key, value, ttlMs);
  return value;
}
