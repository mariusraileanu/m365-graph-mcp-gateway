import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { encryptTokenCache, decryptTokenCache, parseEncryptionKey, isEncryptedCache } from './crypto.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeKey(): Buffer {
  return crypto.randomBytes(32);
}

const SAMPLE_CACHE = JSON.stringify({
  Account: { 'home-1': { username: 'test@example.com' } },
  RefreshToken: { 'rt-1': { secret: 'super-secret-refresh-token' } },
});

// ── encryptTokenCache / decryptTokenCache ───────────────────────────────────

describe('crypto — encrypt / decrypt roundtrip', () => {
  it('roundtrips plaintext through encrypt → decrypt', () => {
    const key = makeKey();
    const encrypted = encryptTokenCache(SAMPLE_CACHE, key);
    const decrypted = decryptTokenCache(encrypted, key);
    assert.equal(decrypted, SAMPLE_CACHE);
  });

  it('produces v1: wire format', () => {
    const key = makeKey();
    const encrypted = encryptTokenCache('hello', key);
    assert.ok(encrypted.startsWith('v1:'), 'should start with v1:');
    const parts = encrypted.split(':');
    assert.equal(parts.length, 4, 'should have 4 colon-separated parts');
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const key = makeKey();
    const a = encryptTokenCache('same', key);
    const b = encryptTokenCache('same', key);
    assert.notEqual(a, b, 'two encryptions of the same plaintext should differ');
  });

  it('handles empty string plaintext', () => {
    const key = makeKey();
    const encrypted = encryptTokenCache('', key);
    const decrypted = decryptTokenCache(encrypted, key);
    assert.equal(decrypted, '');
  });

  it('handles unicode plaintext', () => {
    const key = makeKey();
    const text = '日本語テスト 🔑';
    const encrypted = encryptTokenCache(text, key);
    assert.equal(decryptTokenCache(encrypted, key), text);
  });
});

describe('crypto — wrong key', () => {
  it('throws CACHE_DECRYPTION_FAILED when decrypting with a different key', () => {
    const key1 = makeKey();
    const key2 = makeKey();
    const encrypted = encryptTokenCache(SAMPLE_CACHE, key1);
    assert.throws(() => decryptTokenCache(encrypted, key2), /CACHE_DECRYPTION_FAILED/);
  });
});

describe('crypto — corrupt / malformed data', () => {
  it('throws on missing version prefix', () => {
    const key = makeKey();
    assert.throws(() => decryptTokenCache('bad-data-no-colons', key), /CACHE_DECRYPTION_FAILED/);
  });

  it('throws on wrong version prefix', () => {
    const key = makeKey();
    assert.throws(() => decryptTokenCache('v2:aa:bb:cc', key), /CACHE_DECRYPTION_FAILED/);
  });

  it('throws on truncated payload (too few parts)', () => {
    const key = makeKey();
    assert.throws(() => decryptTokenCache('v1:aabb:ccdd', key), /CACHE_DECRYPTION_FAILED/);
  });

  it('throws on tampered ciphertext', () => {
    const key = makeKey();
    const encrypted = encryptTokenCache('hello', key);
    const parts = encrypted.split(':');
    // Flip a byte in the ciphertext
    const tampered = parts[3]!.replace(/^./, parts[3]![0] === 'a' ? 'b' : 'a');
    const bad = `${parts[0]}:${parts[1]}:${parts[2]}:${tampered}`;
    assert.throws(() => decryptTokenCache(bad, key), /CACHE_DECRYPTION_FAILED/);
  });

  it('throws on tampered auth tag', () => {
    const key = makeKey();
    const encrypted = encryptTokenCache('hello', key);
    const parts = encrypted.split(':');
    const tampered = parts[2]!.replace(/^./, parts[2]![0] === 'a' ? 'b' : 'a');
    const bad = `${parts[0]}:${parts[1]}:${tampered}:${parts[3]}`;
    assert.throws(() => decryptTokenCache(bad, key), /CACHE_DECRYPTION_FAILED/);
  });
});

describe('crypto — key validation', () => {
  it('throws on key that is not 32 bytes (encrypt)', () => {
    const shortKey = crypto.randomBytes(16);
    assert.throws(() => encryptTokenCache('x', shortKey), /32 bytes/);
  });

  it('throws on key that is not 32 bytes (decrypt)', () => {
    const shortKey = crypto.randomBytes(16);
    assert.throws(() => decryptTokenCache('v1:aa:bb:cc', shortKey), /32 bytes/);
  });
});

// ── parseEncryptionKey ──────────────────────────────────────────────────────

describe('parseEncryptionKey', () => {
  it('returns null for undefined', () => {
    assert.equal(parseEncryptionKey(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseEncryptionKey(''), null);
  });

  it('returns null for whitespace-only string', () => {
    assert.equal(parseEncryptionKey('   '), null);
  });

  it('parses a valid base64-encoded 32-byte key', () => {
    const raw = crypto.randomBytes(32);
    const b64 = raw.toString('base64');
    const parsed = parseEncryptionKey(b64);
    assert.ok(parsed);
    assert.equal(parsed.length, 32);
    assert.ok(raw.equals(parsed));
  });

  it('throws on wrong-length key', () => {
    const b64 = crypto.randomBytes(16).toString('base64');
    assert.throws(() => parseEncryptionKey(b64), /32 bytes/);
  });
});

// ── isEncryptedCache ────────────────────────────────────────────────────────

describe('isEncryptedCache', () => {
  it('returns true for v1: prefixed content', () => {
    assert.equal(isEncryptedCache('v1:aabb:ccdd:eeff'), true);
  });

  it('returns false for JSON content', () => {
    assert.equal(isEncryptedCache('{"Account":{}}'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isEncryptedCache(''), false);
  });
});
