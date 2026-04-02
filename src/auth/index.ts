/**
 * Authentication module — per-user isolated delegated Graph bridge.
 *
 * Architecture notes (read before modifying):
 *
 *   This gateway is NOT a shared multi-user backend. Each deployment is a
 *   dedicated container serving exactly one Microsoft identity. Therefore:
 *
 *   - PublicClientApplication is intentional (delegated user auth, not
 *     confidential app auth or OBO). This aligns with Microsoft identity
 *     platform guidance for user-owned helper services.
 *
 *   - Module-level singletons (msal, graph, lastKnownAccount) are acceptable
 *     because there is never more than one concurrent user identity.
 *
 *   - File-based token cache persistence is intentional. The cache lives on
 *     mounted durable storage (NFS in Azure) and survives container restarts
 *     and scale-to-zero events. It is encrypted at rest with AES-256-GCM
 *     when GRAPH_TOKEN_CACHE_ENCRYPTION_KEY is configured.
 *
 *   - If the MSAL cache somehow contains multiple accounts, this is treated
 *     as an invalid state (not silently resolved by picking one).
 *
 *   Do NOT refactor this into a shared auth service, multi-user token broker,
 *   ConfidentialClientApplication, or OBO architecture.
 */

import fs from 'fs';
import path from 'path';
import {
  PublicClientApplication,
  Configuration,
  InteractionRequiredAuthError,
  AccountInfo,
  DeviceCodeRequest,
  ICachePlugin,
  TokenCacheContext,
} from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import open from 'open';
import { loadConfig } from '../config/index.js';
import { resolveStoragePath } from '../utils/helpers.js';
import { log } from '../utils/log.js';
import { encryptTokenCache, decryptTokenCache, parseEncryptionKey, isEncryptedCache } from './crypto.js';
import { atomicWriteFile, safeReadFile } from '../utils/file.js';
import { sendNotification } from '../mcp/server.js';
import type { LoginMode, DeviceCodeInfo } from '../utils/types.js';

// ── Single-user module state ────────────────────────────────────────────────
// These singletons are safe because one gateway = one Microsoft identity.

let msal: PublicClientApplication | null = null;
let graph: Client | null = null;

/**
 * Convenience cache of the current account. Updated by resolveAccount()
 * and login flows. NOT a fallback for ambiguous identity resolution —
 * resolveAccount() enforces the single-account invariant independently.
 */
let lastKnownAccount: AccountInfo | null = null;

/** Whether we have already logged the "no encryption key" warning. */
let encryptionWarningLogged = false;
let lastIdentityMismatchError: string | null = null;

// ── Token cache path ────────────────────────────────────────────────────────

async function getTokenCachePath(): Promise<string> {
  const dir = resolveStoragePath(loadConfig().storage.tokenPath);
  await fs.promises.mkdir(dir, { recursive: true });
  return path.join(dir, 'token-cache.json');
}

function normalizeObjectId(value: string): string {
  return value.trim().toLowerCase();
}

function isObjectId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function expectedObjectId(): string | null {
  const raw = loadConfig().server.expectedAadObjectId;
  if (!raw) return null;
  const normalized = normalizeObjectId(raw);
  return isObjectId(normalized) ? normalized : null;
}

function extractAccountObjectId(account: AccountInfo): string | null {
  const claims = account.idTokenClaims as Record<string, unknown> | undefined;
  const claimOid = typeof claims?.oid === 'string' ? claims.oid : '';
  if (claimOid && isObjectId(claimOid)) return normalizeObjectId(claimOid);

  const localAccountId = account.localAccountId;
  if (localAccountId && isObjectId(localAccountId)) return normalizeObjectId(localAccountId);

  return null;
}

async function quarantineTokenCache(reason: string): Promise<string | null> {
  const cachePath = await getTokenCachePath();
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantinePath = `${cachePath}.quarantine-${suffix}`;
  try {
    await fs.promises.rename(cachePath, quarantinePath);
    log.warn('Token cache quarantined', { reason, cache_path: cachePath, quarantine_path: quarantinePath });
    return quarantinePath;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.warn('Token cache quarantine skipped (cache file absent)', { reason, cache_path: cachePath });
      return null;
    }
    log.error('Token cache quarantine failed', {
      reason,
      cache_path: cachePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function enforceExpectedIdentity(account: AccountInfo): Promise<boolean> {
  const expected = expectedObjectId();
  if (!expected) {
    lastIdentityMismatchError = null;
    return true;
  }

  const actual = extractAccountObjectId(account);
  const user = account.username || 'unknown';

  if (actual && actual === expected) {
    lastIdentityMismatchError = null;
    return true;
  }

  const reason = actual
    ? `TOKEN_IDENTITY_MISMATCH expected=${expected} actual=${actual} user=${user}`
    : `TOKEN_IDENTITY_UNKNOWN expected=${expected} user=${user}`;
  await quarantineTokenCache(reason);

  lastIdentityMismatchError = reason;
  lastKnownAccount = null;
  msal = null;
  graph = null;

  log.error('Token identity validation failed; cache quarantined and login reset', {
    expected_object_id: expected,
    actual_object_id: actual,
    user,
    reason,
  });

  return false;
}

// ── Encryption key (resolved once, cached) ──────────────────────────────────

let resolvedKey: Buffer | null | undefined; // undefined = not yet resolved

function getEncryptionKey(): Buffer | null {
  if (resolvedKey !== undefined) return resolvedKey;
  resolvedKey = parseEncryptionKey(loadConfig().storage.encryptionKey);
  if (!resolvedKey && !encryptionWarningLogged) {
    log.warn('Token cache encryption key not set — cache is stored in plaintext. Set GRAPH_TOKEN_CACHE_ENCRYPTION_KEY for production.');
    encryptionWarningLogged = true;
  }
  return resolvedKey;
}

// ── Cache plugin (encrypted + atomic writes) ────────────────────────────────

function createCachePlugin(): ICachePlugin {
  return {
    async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
      const cachePath = await getTokenCachePath();
      const raw = await safeReadFile(cachePath);
      if (!raw) return; // no cache file yet — fresh state

      const key = getEncryptionKey();
      let json: string;

      if (key && isEncryptedCache(raw)) {
        // Normal path: encrypted cache + key available
        try {
          json = decryptTokenCache(raw, key);
        } catch (err) {
          log.error('Failed to decrypt token cache', { error: err instanceof Error ? err.message : String(err) });
          throw new Error(
            'CACHE_DECRYPTION_FAILED: could not decrypt token cache — wrong key or corrupt file. Run --logout and re-authenticate.',
          );
        }
      } else if (key && !isEncryptedCache(raw)) {
        // Migration: plaintext cache exists but encryption key is now set.
        // Encrypt the file eagerly — afterCacheAccess only fires when MSAL
        // considers the cache "changed", which won't happen on read-only
        // operations like health checks or silent token acquisition.
        log.warn('Migrating plaintext token cache to encrypted format');
        await atomicWriteFile(cachePath, encryptTokenCache(raw, key), 0o600);
        log.info('Token cache migration to encrypted format complete');
        json = raw;
      } else {
        // No encryption key configured — read as plaintext
        json = raw;
      }

      ctx.tokenCache.deserialize(json);
    },

    async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
      if (!ctx.cacheHasChanged) return;

      const cachePath = await getTokenCachePath();
      const serialized = ctx.tokenCache.serialize();
      const key = getEncryptionKey();

      const content = key ? encryptTokenCache(serialized, key) : serialized;
      await atomicWriteFile(cachePath, content, 0o600);
    },
  };
}

// ── MSAL client ─────────────────────────────────────────────────────────────

async function getMsal(): Promise<PublicClientApplication> {
  if (msal) return msal;
  const cfg = loadConfig();
  const conf: Configuration = {
    auth: {
      clientId: cfg.azure.clientId,
      authority: `https://login.microsoftonline.com/${cfg.azure.tenantId}`,
    },
    cache: {
      cachePlugin: createCachePlugin(),
    },
  };
  msal = new PublicClientApplication(conf);
  return msal;
}

// ── Account resolution (single-account enforcement) ─────────────────────────

/**
 * Resolve the current account from the MSAL cache.
 *
 * Enforces the single-user-per-gateway invariant:
 *   0 accounts → null (not logged in)
 *   1 account  → that account
 *  >1 accounts → error (invalid state)
 */
async function resolveAccount(): Promise<AccountInfo | null> {
  const app = await getMsal();
  const accounts = await app.getTokenCache().getAllAccounts();

  if (accounts.length === 0) {
    lastKnownAccount = null;
    return null;
  }

  if (accounts.length === 1) {
    const account = accounts[0] ?? null;
    if (!account) {
      lastKnownAccount = null;
      return null;
    }
    const identityOk = await enforceExpectedIdentity(account);
    if (!identityOk) {
      return null;
    }
    lastKnownAccount = account;
    return lastKnownAccount;
  }

  // >1 accounts — this gateway should only ever have one
  throw new Error('MULTIPLE_ACCOUNTS_IN_CACHE: this gateway is designed for one user only. Run --logout and authenticate again.');
}

// ── Public API — auth state ─────────────────────────────────────────────────

export async function currentUser(): Promise<string | null> {
  const account = await resolveAccount();
  return account?.username ?? null;
}

export async function isLoggedIn(): Promise<boolean> {
  const account = await resolveAccount();
  return account !== null;
}

// ── Login flows ─────────────────────────────────────────────────────────────

// ── Device code flow state ──────────────────────────────────────────────────
// These track a background device-code login that the caller can poll via
// deviceCodeLoginStatus().

let pendingDeviceCodeInfo: DeviceCodeInfo | null = null;
let pendingDeviceCodePromise: Promise<void> | null = null;
let pendingDeviceCodeError: string | null = null;

/**
 * Start a device-code login and return the code/URL immediately.
 *
 * The actual token acquisition continues in the background. Callers should
 * use `deviceCodeLoginStatus()` to poll for completion.
 */
export async function startDeviceCodeLogin(): Promise<DeviceCodeInfo> {
  // If there's already a pending flow, return the existing code info
  if (pendingDeviceCodeInfo && pendingDeviceCodePromise) {
    return pendingDeviceCodeInfo;
  }

  const app = await getMsal();

  // Promise that resolves once the deviceCodeCallback fires (fast — happens
  // almost immediately when MSAL contacts the /devicecode endpoint).
  let resolveCodeReady: () => void;
  const codeReady = new Promise<void>((resolve) => {
    resolveCodeReady = resolve;
  });

  pendingDeviceCodeError = null;

  const request: DeviceCodeRequest = {
    scopes: loadConfig().scopes,
    deviceCodeCallback: (res) => {
      pendingDeviceCodeInfo = {
        userCode: res.userCode,
        verificationUri: res.verificationUri,
        message: res.message,
        expiresIn: res.expiresIn,
      };

      // Emit MCP logging notification (reaches the client in stdio mode)
      sendNotification('notice', 'auth', {
        message: res.message,
        verification_uri: res.verificationUri,
        user_code: res.userCode,
      });

      // Also log to stderr as a fallback for non-MCP (CLI) usage
      log.info('Device code login', {
        verification_uri: res.verificationUri,
        user_code: res.userCode,
      });

      resolveCodeReady!();
    },
  };

  // Start the token acquisition but do NOT await it — let it run in the
  // background so we can return the code to the caller immediately.
  pendingDeviceCodePromise = app
    .acquireTokenByDeviceCode(request)
    .then((response) => {
      if (!response?.account) throw new Error('LOGIN_FAILED: device code login did not return an account');
      lastKnownAccount = response.account;
      // cachePlugin.afterCacheAccess persists tokens automatically
    })
    .catch((err) => {
      pendingDeviceCodeError = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      pendingDeviceCodeInfo = null;
      pendingDeviceCodePromise = null;
    });

  // Wait only for the callback to fire (fast — typically <1s)
  await codeReady;
  return pendingDeviceCodeInfo!;
}

/** Check the status of a pending device code login. */
export function deviceCodeLoginStatus(): { pending: boolean; error: string | null } {
  if (pendingDeviceCodePromise) {
    return { pending: true, error: null };
  }
  return { pending: false, error: pendingDeviceCodeError };
}

/**
 * Blocking device code login — used only by the CLI (--login-device).
 * Waits for the full flow to complete before returning.
 */
async function loginDeviceCode(): Promise<void> {
  await startDeviceCodeLogin();
  // Now await the background promise to completion
  if (pendingDeviceCodePromise) {
    await pendingDeviceCodePromise;
  }
  if (pendingDeviceCodeError) {
    throw new Error(pendingDeviceCodeError);
  }
}

async function loginInteractive(): Promise<void> {
  const app = await getMsal();

  const response = await app.acquireTokenInteractive({
    scopes: loadConfig().scopes,
    openBrowser: async (url: string) => {
      await open(url);
    },
  });

  if (!response?.account) throw new Error('LOGIN_FAILED: interactive login did not return an account');
  lastKnownAccount = response.account;
  // cachePlugin.afterCacheAccess persists tokens automatically
}

export async function login(mode: LoginMode): Promise<void> {
  if (mode === 'device') {
    await loginDeviceCode();
    return;
  }

  try {
    await loginInteractive();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`INTERACTIVE_LOGIN_FAILED: ${message}. Use --login-device if running headless.`);
  }
}

// ── Logout ──────────────────────────────────────────────────────────────────

export async function logout(): Promise<void> {
  // Clear in-memory state
  lastKnownAccount = null;
  msal = null;
  graph = null;
  resolvedKey = undefined; // allow re-resolution on next access
  pendingDeviceCodeInfo = null;
  pendingDeviceCodePromise = null;
  pendingDeviceCodeError = null;

  // Remove token cache file
  const cachePath = await getTokenCachePath();
  try {
    await fs.promises.unlink(cachePath);
    log.info('Token cache file removed', { path: cachePath });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.info('Token cache file already absent', { path: cachePath });
    } else {
      log.warn('Failed to remove token cache file', { path: cachePath, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ── Token acquisition ───────────────────────────────────────────────────────

export async function getAccessToken(): Promise<string> {
  const app = await getMsal();
  const account = await resolveAccount();

  if (!account) {
    if (lastIdentityMismatchError) {
      throw new Error(`AUTH_REQUIRED: ${lastIdentityMismatchError}. Re-authenticate with login_device.`);
    }
    throw new Error('AUTH_REQUIRED: not logged in, run --login first');
  }

  const scopes = loadConfig().scopes;
  let lastError: unknown;

  // Retry once on transient failures (network glitches, MSAL service hiccups)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await app.acquireTokenSilent({ scopes, account });
      return response.accessToken;
    } catch (error) {
      lastError = error;
      if (error instanceof InteractionRequiredAuthError) {
        // Non-transient — user must re-authenticate, no retry
        log.warn('Token expired, re-authentication required');
        throw new Error('AUTH_EXPIRED: run --login to re-authenticate');
      }
      if (attempt === 0) {
        log.warn('Token refresh failed, retrying', { error: error instanceof Error ? error.message : String(error) });
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  log.error('Token refresh failed after retry', { error: lastError instanceof Error ? lastError.message : String(lastError) });
  throw lastError;
}

// ── Graph client ────────────────────────────────────────────────────────────

export function getGraph(): Client {
  if (!graph) {
    graph = Client.init({
      authProvider: async (done) => {
        try {
          done(null, await getAccessToken());
        } catch (e) {
          done(e instanceof Error ? e : new Error(String(e)), null);
        }
      },
      fetchOptions: { keepalive: true },
    });
  }
  return graph;
}

// ── Startup identity verification ───────────────────────────────────────────

export interface IdentityVerificationResult {
  checked: boolean;
  mismatch: boolean;
  cached_user: string | null;
  cached_object_id: string | null;
  expected_object_id: string | null;
  reason?: string;
  quarantined_path?: string;
}

/**
 * Verify that the cached MSAL identity matches the expected Entra object ID for this
 * container's USER_SLUG. Called once at startup.
 *
 * - If EXPECTED_AAD_OBJECT_ID is not set, the check is skipped (backward compat).
 * - If no account is cached (not logged in), the check is skipped.
 * - If the object ID matches, logs success and returns.
 * - If the object ID does NOT match, quarantines the cache file, clears in-memory
 *   state, and returns a mismatch result so the caller can log and continue.
 *
 * This function is idempotent: after quarantine the cache is empty, so
 * subsequent calls find 0 accounts and skip.
 */
export async function verifyIdentityBinding(): Promise<IdentityVerificationResult> {
  const expectedOid = expectedObjectId();
  const slug = process.env.USER_SLUG ?? 'unknown';

  if (!expectedOid) {
    log.info('Identity binding check skipped — EXPECTED_AAD_OBJECT_ID not set', { slug });
    return {
      checked: false,
      mismatch: false,
      cached_user: null,
      cached_object_id: null,
      expected_object_id: null,
    };
  }

  const app = await getMsal();
  const accounts = await app.getTokenCache().getAllAccounts();

  if (accounts.length === 0) {
    log.info('Identity binding check skipped — no cached account', {
      slug,
      expected_object_id: expectedOid,
    });
    return {
      checked: true,
      mismatch: false,
      cached_user: null,
      cached_object_id: null,
      expected_object_id: expectedOid,
    };
  }

  if (accounts.length > 1) {
    const reason = 'MULTIPLE_ACCOUNTS_IN_CACHE: this gateway is designed for one user only. Run --logout and authenticate again.';
    let quarantinedPath: string | null = null;
    try {
      quarantinedPath = await quarantineTokenCache(reason);
    } catch {
      quarantinedPath = null;
    }
    lastIdentityMismatchError = reason;
    lastKnownAccount = null;
    msal = null;
    graph = null;
    resolvedKey = undefined;
    return {
      checked: true,
      mismatch: true,
      cached_user: null,
      cached_object_id: null,
      expected_object_id: expectedOid,
      reason,
      quarantined_path: quarantinedPath ?? undefined,
    };
  }

  const account = accounts[0];
  const cachedUser = account?.username ?? null;
  const cachedOid = account ? extractAccountObjectId(account) : null;

  if (cachedOid && cachedOid === expectedOid) {
    log.info('Identity verified', { slug, user: cachedUser, object_id: cachedOid });
    return {
      checked: true,
      mismatch: false,
      cached_user: cachedUser,
      cached_object_id: cachedOid,
      expected_object_id: expectedOid,
    };
  }

  // ── MISMATCH — quarantine the cache ─────────────────────────────────────
  const reason = cachedOid
    ? `TOKEN_IDENTITY_MISMATCH expected=${expectedOid} actual=${cachedOid} user=${cachedUser}`
    : `TOKEN_IDENTITY_UNKNOWN expected=${expectedOid} user=${cachedUser}`;
  log.warn('TOKEN_IDENTITY_MISMATCH', {
    slug,
    expected_object_id: expectedOid,
    actual_object_id: cachedOid,
    user: cachedUser,
  });

  let quarantinedPath: string | null = null;
  try {
    quarantinedPath = await quarantineTokenCache(reason);
  } catch {
    quarantinedPath = null;
  }

  // Clear all in-memory auth state — force fresh login
  lastIdentityMismatchError = reason;
  lastKnownAccount = null;
  msal = null;
  graph = null;
  resolvedKey = undefined;

  return {
    checked: true,
    mismatch: true,
    cached_user: cachedUser,
    cached_object_id: cachedOid,
    expected_object_id: expectedOid,
    reason,
    quarantined_path: quarantinedPath ?? undefined,
  };
}

// ── Auth diagnostics ────────────────────────────────────────────────────────

export interface AuthStatusResult {
  logged_in: boolean;
  user: string | null;
  cache_file_exists: boolean;
  cache_encrypted: boolean;
  cache_decryptable: boolean;
  encryption_key_configured: boolean;
  account_count: number;
  graph_reachable: boolean;
  device_code_pending: boolean;
  expected_object_id: string | null;
  actual_object_id: string | null;
  identity_match: boolean | null;
  device_code_verification_uri?: string;
  device_code_user_code?: string;
  error?: string;
}

/**
 * Lightweight diagnostics for auth troubleshooting.
 * Does NOT throw — returns structured status even on failures.
 */
export async function authStatus(): Promise<AuthStatusResult> {
  const result: AuthStatusResult = {
    logged_in: false,
    user: null,
    cache_file_exists: false,
    cache_encrypted: false,
    cache_decryptable: false,
    encryption_key_configured: false,
    account_count: 0,
    graph_reachable: false,
    device_code_pending: pendingDeviceCodePromise !== null,
    expected_object_id: expectedObjectId(),
    actual_object_id: null,
    identity_match: null,
  };

  // Include device code info if a flow is in progress
  if (pendingDeviceCodeInfo) {
    result.device_code_verification_uri = pendingDeviceCodeInfo.verificationUri;
    result.device_code_user_code = pendingDeviceCodeInfo.userCode;
  }

  // Check encryption key
  try {
    result.encryption_key_configured = getEncryptionKey() !== null;
  } catch {
    result.encryption_key_configured = false;
  }

  // Check cache file
  const cachePath = await getTokenCachePath();
  const raw = await safeReadFile(cachePath);
  result.cache_file_exists = raw !== null;

  if (raw) {
    result.cache_encrypted = isEncryptedCache(raw);

    // Try to decrypt/parse
    try {
      const key = getEncryptionKey();
      let json: string;
      if (key && isEncryptedCache(raw)) {
        json = decryptTokenCache(raw, key);
      } else {
        json = raw;
      }
      // Verify it's valid JSON
      JSON.parse(json);
      result.cache_decryptable = true;
    } catch {
      result.cache_decryptable = false;
    }
  }

  // Check accounts
  try {
    const app = await getMsal();
    const accounts = await app.getTokenCache().getAllAccounts();
    result.account_count = accounts.length;

    if (accounts.length === 1) {
      const account = accounts[0];
      result.user = account?.username ?? null;
      result.actual_object_id = account ? extractAccountObjectId(account) : null;
      if (result.expected_object_id) {
        if (result.actual_object_id) {
          result.identity_match = result.actual_object_id === result.expected_object_id;
          if (!result.identity_match) {
            result.error = `TOKEN_IDENTITY_MISMATCH: expected=${result.expected_object_id} actual=${result.actual_object_id}`;
          }
        } else {
          result.identity_match = false;
          result.error = `TOKEN_IDENTITY_UNKNOWN: expected=${result.expected_object_id}`;
        }
      } else {
        result.identity_match = null;
      }

      if (result.identity_match === false) {
        result.logged_in = false;
      } else {
        result.logged_in = true;
      }
    } else if (accounts.length > 1) {
      result.error = 'MULTIPLE_ACCOUNTS_IN_CACHE: this gateway is designed for one user only. Run --logout and authenticate again.';
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  // Check Graph reachability (only if logged in)
  if (result.logged_in) {
    try {
      await getGraph().api('/me').select('id').get();
      result.graph_reachable = true;
    } catch {
      result.graph_reachable = false;
    }
  }

  return result;
}
