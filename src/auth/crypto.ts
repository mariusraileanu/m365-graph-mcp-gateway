/**
 * Token cache encryption — AES-256-GCM.
 *
 * This module encrypts/decrypts the MSAL token cache blob before it is
 * persisted to disk.  The encryption key is a 32-byte value supplied via
 * the GRAPH_TOKEN_CACHE_ENCRYPTION_KEY environment variable (base64-encoded).
 *
 * Wire format (all hex, colon-separated):
 *   v1:<iv>:<authTag>:<ciphertext>
 *
 * - v1        — version tag (allows future format changes)
 * - iv        — 12-byte random initialisation vector (hex)
 * - authTag   — 16-byte GCM authentication tag (hex)
 * - ciphertext — encrypted payload (hex)
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard
const AUTH_TAG_BYTES = 16;
const VERSION = 'v1';

/** Encrypt a plaintext string.  Returns the `v1:iv:tag:ciphertext` wire format. */
export function encryptTokenCache(plaintext: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error('CRYPTO_ERROR: encryption key must be exactly 32 bytes');
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Decrypt a `v1:iv:tag:ciphertext` wire-format string back to plaintext. */
export function decryptTokenCache(ciphertext: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error('CRYPTO_ERROR: encryption key must be exactly 32 bytes');
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('CACHE_DECRYPTION_FAILED: unrecognised cache format (expected v1:iv:tag:data)');
  }

  const [, ivHex, tagHex, dataHex] = parts as [string, string, string, string];

  let iv: Buffer;
  let authTag: Buffer;
  let data: Buffer;
  try {
    iv = Buffer.from(ivHex, 'hex');
    authTag = Buffer.from(tagHex, 'hex');
    data = Buffer.from(dataHex, 'hex');
  } catch {
    throw new Error('CACHE_DECRYPTION_FAILED: malformed hex in cache file');
  }

  if (iv.length !== IV_BYTES) {
    throw new Error('CACHE_DECRYPTION_FAILED: invalid IV length');
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error('CACHE_DECRYPTION_FAILED: invalid auth tag length');
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch {
    throw new Error('CACHE_DECRYPTION_FAILED: decryption failed — wrong key or corrupt cache file. Run --logout and re-authenticate.');
  }
}

/**
 * Parse a base64-encoded encryption key string into a 32-byte Buffer.
 * Returns null if the input is falsy/empty.
 * Throws if the input is present but invalid.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw || raw.trim() === '') return null;

  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('CRYPTO_ERROR: GRAPH_TOKEN_CACHE_ENCRYPTION_KEY is not valid base64');
  }

  if (buf.length !== 32) {
    throw new Error(
      `CRYPTO_ERROR: encryption key must be 32 bytes (got ${buf.length}). Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  return buf;
}

/**
 * Detect whether a cache file's content looks encrypted (starts with `v1:`).
 * Used for transparent migration from plaintext → encrypted caches.
 */
export function isEncryptedCache(content: string): boolean {
  return content.startsWith(`${VERSION}:`);
}
