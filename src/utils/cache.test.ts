import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MicroCache } from './cache.js';

describe('MicroCache', () => {
  let cache: MicroCache<string>;

  beforeEach(() => {
    cache = new MicroCache<string>();
  });

  it('returns undefined for missing keys', () => {
    assert.equal(cache.get('nonexistent'), undefined);
  });

  it('stores and retrieves a value', () => {
    cache.set('key1', 'value1');
    assert.equal(cache.get('key1'), 'value1');
  });

  it('overwrites existing keys', () => {
    cache.set('key1', 'v1');
    cache.set('key1', 'v2');
    assert.equal(cache.get('key1'), 'v2');
    assert.equal(cache.size, 1);
  });

  it('supports different value types via generic', () => {
    const numCache = new MicroCache<number>();
    numCache.set('count', 42);
    assert.equal(numCache.get('count'), 42);

    const objCache = new MicroCache<{ id: string }>();
    objCache.set('item', { id: 'abc' });
    assert.deepStrictEqual(objCache.get('item'), { id: 'abc' });
  });

  it('reports correct size', () => {
    assert.equal(cache.size, 0);
    cache.set('a', '1');
    assert.equal(cache.size, 1);
    cache.set('b', '2');
    assert.equal(cache.size, 2);
  });

  it('clears all entries', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), undefined);
  });
});

describe('MicroCache — TTL expiry', () => {
  it('returns undefined for expired entries', () => {
    const cache = new MicroCache<string>();
    // Set with a very short TTL (1 ms) and rely on Date.now() advancing
    cache.set('ephemeral', 'gone', 1);

    // Busy-wait until at least 2ms pass to ensure expiry
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }

    assert.equal(cache.get('ephemeral'), undefined);
    // Expired entry should be removed on get
    assert.equal(cache.size, 0);
  });

  it('returns value before TTL expires', () => {
    const cache = new MicroCache<string>();
    cache.set('lasting', 'here', 60_000); // 60 s
    assert.equal(cache.get('lasting'), 'here');
  });
});

describe('MicroCache — sweep', () => {
  it('removes expired entries during sweep', () => {
    const cache = new MicroCache<string>();
    cache.set('expired1', 'v1', 1);
    cache.set('expired2', 'v2', 1);
    cache.set('valid', 'v3', 60_000);

    // Wait for short-TTL entries to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }

    cache.sweep();
    assert.equal(cache.size, 1);
    assert.equal(cache.get('valid'), 'v3');
  });
});

describe('MicroCache — eviction', () => {
  it('evicts oldest entry when exceeding max entries', () => {
    const cache = new MicroCache<number>();
    // MicroCache has MAX_ENTRIES = 500, fill past it
    for (let i = 0; i < 502; i++) {
      cache.set(`key-${i}`, i, 60_000);
    }
    // Should be capped at 501 (eviction happens one-at-a-time after exceeding 500)
    assert.ok(cache.size <= 501);
    // Oldest keys should be evicted
    assert.equal(cache.get('key-0'), undefined);
    // Recent keys should remain
    assert.equal(cache.get('key-501'), 501);
  });
});
