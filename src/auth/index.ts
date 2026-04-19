/**
 * Single-user delegated Graph auth.
 * This module intentionally keeps one MSAL cache and one Graph client per
 * gateway instance, and pins account selection to EXPECTED_AAD_OBJECT_ID.
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
import { resolveStoragePath, requireUserSlug } from '../utils/helpers.js';
import { log } from '../utils/log.js';
import { encryptTokenCache, decryptTokenCache, parseEncryptionKey, isEncryptedCache } from './crypto.js';
import { atomicWriteFile, safeReadFile } from '../utils/file.js';
import { isObjectId, normalizeObjectId, parseObjectId } from '../utils/object-id.js';
import type { AuthStatusResult, DeviceCodeInfo, IdentityVerificationResult, LoginMode } from './types.js';

let msal: PublicClientApplication | null = null;
let graph: Client | null = null;

let encryptionWarningLogged = false;
let lastIdentityMismatchError: string | null = null;
type AuthNotifier = (info: DeviceCodeInfo) => void;
let authNotifier: AuthNotifier | null = null;

export function setAuthNotifier(notifier: AuthNotifier | null): void {
  authNotifier = notifier;
}

async function getTokenCachePath(): Promise<string> {
  const dir = resolveStoragePath(loadConfig().storage.tokenPath);
  await fs.promises.mkdir(dir, { recursive: true });
  return path.join(dir, 'token-cache.json');
}

async function getTokenCacheMetadataPath(): Promise<string> {
  const dir = resolveStoragePath(loadConfig().storage.tokenPath);
  await fs.promises.mkdir(dir, { recursive: true });
  return path.join(dir, 'token-cache.meta.json');
}

function expectedObjectId(): string | null {
  return parseObjectId(loadConfig().server.expectedAadObjectId);
}

/**
 * Require EXPECTED_AAD_OBJECT_ID to be set and valid.
 * Throws CONFIG_ERROR if missing or malformed.
 */
function requireExpectedObjectId(): string {
  const oid = expectedObjectId();
  if (!oid) {
    throw new Error('CONFIG_ERROR: EXPECTED_AAD_OBJECT_ID is required. Set it in .env or as an environment variable.');
  }
  return oid;
}

function extractAccountObjectId(account: AccountInfo): string | null {
  const claims = account.idTokenClaims as Record<string, unknown> | undefined;
  const claimOid = typeof claims?.oid === 'string' ? claims.oid : '';
  if (claimOid && isObjectId(claimOid)) return normalizeObjectId(claimOid);

  const localAccountId = account.localAccountId;
  if (localAccountId && isObjectId(localAccountId)) return normalizeObjectId(localAccountId);

  return null;
}

type AccountMatchResult =
  | { kind: 'matched'; account: AccountInfo }
  | { kind: 'no_match'; cached: AccountInfo[]; reason: string }
  | { kind: 'multi_match'; cached: AccountInfo[]; reason: string };

/**
 * Find the account in the MSAL cache that matches EXPECTED_AAD_OBJECT_ID.
 *
 * - 0 accounts → no_match (not logged in)
 * - 1+ accounts, exactly 1 OID match → matched
 * - 1+ accounts, 0 OID matches → no_match (wrong user or unknown OID)
 * - 1+ accounts, >1 OID matches → multi_match (corrupted cache, fail closed)
 */
function findMatchingAccount(accounts: AccountInfo[], expectedOid: string): AccountMatchResult {
  const matches = accounts.filter((a) => {
    const oid = extractAccountObjectId(a);
    return oid !== null && oid === expectedOid;
  });

  if (matches.length === 1) {
    return { kind: 'matched', account: matches[0]! };
  }

  if (matches.length === 0) {
    const reason =
      accounts.length === 0
        ? 'No cached accounts'
        : `No account matches expected OID ${expectedOid} (${accounts.length} cached account(s))`;
    return { kind: 'no_match', cached: accounts, reason };
  }

  return {
    kind: 'multi_match',
    cached: accounts,
    reason: `Multiple accounts match OID ${expectedOid} — corrupted cache`,
  };
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

// ── Token cache metadata ────────────────────────────────────────────────────

interface TokenCacheMetadata {
  expected_aad_object_id: string;
  user_slug: string;
  created_at: string;
  last_validated_at: string;
}

async function writeTokenCacheMetadata(expectedOid: string): Promise<void> {
  const metaPath = await getTokenCacheMetadataPath();
  const slug = requireUserSlug();
  const now = new Date().toISOString();

  let createdAt = now;
  try {
    const existing = await safeReadFile(metaPath);
    if (existing && existing.trim()) {
      const parsed = JSON.parse(existing) as Partial<TokenCacheMetadata>;
      if (parsed.created_at) createdAt = parsed.created_at;
    }
  } catch (err) {
    log.warn('Ignoring invalid token cache metadata and rewriting it', {
      path: metaPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const metadata: TokenCacheMetadata = {
    expected_aad_object_id: expectedOid,
    user_slug: slug,
    created_at: createdAt,
    last_validated_at: now,
  };

  await atomicWriteFile(metaPath, JSON.stringify(metadata, null, 2), 0o600);
}

async function writeTokenCacheMetadataBestEffort(expectedOid: string, context: string): Promise<void> {
  try {
    await writeTokenCacheMetadata(expectedOid);
  } catch (err) {
    log.warn('Failed to write token cache metadata', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
      if (raw === null) return;
      if (raw.length === 0) {
        throw new Error('TOKEN_CACHE_CORRUPTED: token cache file is empty. Run --logout and re-authenticate.');
      }

      const key = getEncryptionKey();
      let json: string;

      if (key && isEncryptedCache(raw)) {
        try {
          json = decryptTokenCache(raw, key);
        } catch (err) {
          log.error('Failed to decrypt token cache', { error: err instanceof Error ? err.message : String(err) });
          throw new Error(
            'CACHE_DECRYPTION_FAILED: could not decrypt token cache — wrong key or corrupt file. Run --logout and re-authenticate.',
          );
        }
      } else if (key) {
        throw new Error(
          'CACHE_DECRYPTION_FAILED: token cache is not encrypted but GRAPH_TOKEN_CACHE_ENCRYPTION_KEY is set. Clear the cache and re-authenticate.',
        );
      } else {
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

// ── Account resolution (OID-based selection) ────────────────────────────────

/**
 * Resolve the current account from the MSAL cache using OID-based matching.
 *
 * Requires EXPECTED_AAD_OBJECT_ID — throws CONFIG_ERROR if not set.
 * Uses findMatchingAccount() to select the correct account by OID.
 *
 *   matched     → return that account
 *   no_match    → null (not logged in, or wrong user's cache)
 *   multi_match → quarantine + throw (corrupted state)
 */
async function resolveAccount(): Promise<AccountInfo | null> {
  const expectedOid = requireExpectedObjectId();
  const app = await getMsal();
  const accounts = await app.getTokenCache().getAllAccounts();

  if (accounts.length === 0) {
    return null;
  }

  const result = findMatchingAccount(accounts, expectedOid);

  switch (result.kind) {
    case 'matched':
      lastIdentityMismatchError = null;
      return result.account;

    case 'no_match': {
      const reason = `AUTH_MISMATCH: ${result.reason}`;
      await quarantineTokenCache(reason);
      lastIdentityMismatchError = reason;
      msal = null;
      graph = null;
      log.error('Account resolution failed — no OID match; cache quarantined', {
        expected_object_id: expectedOid,
        cached_count: result.cached.length,
        reason: result.reason,
      });
      return null;
    }

    case 'multi_match': {
      const reason = `TOKEN_CACHE_CORRUPTED: ${result.reason}`;
      await quarantineTokenCache(reason);
      lastIdentityMismatchError = reason;
      msal = null;
      graph = null;
      log.error('Multiple accounts match expected OID — cache quarantined', {
        expected_object_id: expectedOid,
        match_count: result.cached.length,
      });
      throw new Error(`TOKEN_CACHE_CORRUPTED: ${result.reason}. Run --logout and re-authenticate.`);
    }
  }
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
let pendingDeviceCodeInfo: DeviceCodeInfo | null = null;
let pendingDeviceCodePromise: Promise<void> | null = null;
let pendingDeviceCodeError: string | null = null;
let pendingDeviceCodeExpiresAtMs: number | null = null;
let deviceCodeFlowSeq = 0;
let activeDeviceCodeFlowSeq: number | null = null;

export function _forcePendingDeviceCodeExpiryForTest(): void {
  if (pendingDeviceCodePromise) {
    pendingDeviceCodeExpiresAtMs = Date.now() - 6_000;
  }
}

function clearPendingDeviceCodeState(): void {
  pendingDeviceCodeInfo = null;
  pendingDeviceCodePromise = null;
  pendingDeviceCodeExpiresAtMs = null;
  activeDeviceCodeFlowSeq = null;
}

function isPendingDeviceCodeExpired(now = Date.now()): boolean {
  return pendingDeviceCodeExpiresAtMs !== null && now >= pendingDeviceCodeExpiresAtMs + 5_000;
}

/**
 * Start a device-code login and return the code/URL immediately.
 *
 * Requires EXPECTED_AAD_OBJECT_ID — throws CONFIG_ERROR if not set.
 *
 * The actual token acquisition continues in the background. Callers should
 * use `deviceCodeLoginStatus()` to poll for completion.
 */
export async function startDeviceCodeLogin(): Promise<DeviceCodeInfo> {
  requireExpectedObjectId();

  if (pendingDeviceCodeInfo && pendingDeviceCodePromise) {
    if (isPendingDeviceCodeExpired()) {
      pendingDeviceCodeError = 'AUTH_EXPIRED: device code expired — start login_device again';
      clearPendingDeviceCodeState();
    } else {
      return pendingDeviceCodeInfo;
    }
  }

  if (pendingDeviceCodePromise) {
    if (isPendingDeviceCodeExpired()) {
      pendingDeviceCodeError = 'AUTH_EXPIRED: device code expired — start login_device again';
      clearPendingDeviceCodeState();
    } else {
      throw new Error('LOGIN_IN_PROGRESS: device code login already in progress');
    }
  }

  const flowSeq = ++deviceCodeFlowSeq;
  activeDeviceCodeFlowSeq = flowSeq;

  const app = await getMsal();

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
      pendingDeviceCodeExpiresAtMs = Date.now() + res.expiresIn * 1000;

      authNotifier?.(pendingDeviceCodeInfo);

      log.info('Device code login', {
        verification_uri: res.verificationUri,
        user_code: res.userCode,
      });

      resolveCodeReady!();
    },
  };

  pendingDeviceCodePromise = app
    .acquireTokenByDeviceCode(request)
    .then(async (response) => {
      if (activeDeviceCodeFlowSeq !== flowSeq) return;
      if (!response?.account) throw new Error('LOGIN_FAILED: device code login did not return an account');
      const oid = expectedObjectId();
      if (oid) await writeTokenCacheMetadataBestEffort(oid, 'device_login');
    })
    .catch((err) => {
      if (activeDeviceCodeFlowSeq !== flowSeq) return;
      pendingDeviceCodeError = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      if (activeDeviceCodeFlowSeq !== flowSeq) return;
      clearPendingDeviceCodeState();
    });

  await codeReady;
  return pendingDeviceCodeInfo!;
}

/** Check the status of a pending device code login. */
export function deviceCodeLoginStatus(): { pending: boolean; error: string | null } {
  if (pendingDeviceCodePromise) {
    if (isPendingDeviceCodeExpired()) {
      pendingDeviceCodeError = 'AUTH_EXPIRED: device code expired — start login_device again';
      clearPendingDeviceCodeState();
      return { pending: false, error: pendingDeviceCodeError };
    }
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
  if (pendingDeviceCodePromise) {
    await pendingDeviceCodePromise;
  }
  if (pendingDeviceCodeError) {
    throw new Error(pendingDeviceCodeError);
  }
}

async function loginInteractive(): Promise<void> {
  requireExpectedObjectId();

  const app = await getMsal();

  const response = await app.acquireTokenInteractive({
    scopes: loadConfig().scopes,
    openBrowser: async (url: string) => {
      await open(url);
    },
  });

  if (!response?.account) throw new Error('LOGIN_FAILED: interactive login did not return an account');

  const oid = expectedObjectId();
  if (oid) await writeTokenCacheMetadataBestEffort(oid, 'interactive_login');
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
    if (message.startsWith('CONFIG_ERROR')) throw error;
    throw new Error(`INTERACTIVE_LOGIN_FAILED: ${message}. Use --login-device if running headless.`);
  }
}

// ── Logout ──────────────────────────────────────────────────────────────────

export async function logout(): Promise<void> {
  msal = null;
  graph = null;
  resolvedKey = undefined; // allow re-resolution on next access
  pendingDeviceCodeInfo = null;
  pendingDeviceCodePromise = null;
  pendingDeviceCodeError = null;
  pendingDeviceCodeExpiresAtMs = null;
  activeDeviceCodeFlowSeq = null;

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

  const metaPath = await getTokenCacheMetadataPath();
  try {
    await fs.promises.unlink(metaPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn('Failed to remove token cache metadata file', { path: metaPath, error: err instanceof Error ? err.message : String(err) });
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

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await app.acquireTokenSilent({ scopes, account });
      return response.accessToken;
    } catch (error) {
      lastError = error;
      if (error instanceof InteractionRequiredAuthError) {
        log.warn('Token expired, re-authentication required');
        throw new Error('AUTH_EXPIRED: run --login to re-authenticate');
      }
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('AADSTS70043') || errMsg.includes('invalid_grant')) {
        log.warn('Refresh token expired (Conditional Access policy)', { error: errMsg });
        throw new Error('AUTH_EXPIRED: refresh token expired — re-authenticate with login_device');
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

/**
 * Verify that the cached MSAL identity matches the expected Entra object ID for this
 * container's USER_SLUG. Called once at startup.
 *
 * Requires EXPECTED_AAD_OBJECT_ID — throws CONFIG_ERROR if not set.
 *
 * Uses findMatchingAccount() for OID-based selection:
 *   - matched     → logs success, writes metadata, returns OK
 *   - no_match    → quarantines cache, returns mismatch
 *   - multi_match → quarantines cache, returns mismatch (fail closed)
 *
 * This function is idempotent: after quarantine the cache is empty, so
 * subsequent calls find 0 accounts and skip.
 */
export async function verifyIdentityBinding(): Promise<IdentityVerificationResult> {
  const expectedOid = requireExpectedObjectId();
  const slug = requireUserSlug();

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

  const matchResult = findMatchingAccount(accounts, expectedOid);

  switch (matchResult.kind) {
    case 'matched': {
      const account = matchResult.account;
      const cachedUser = account.username ?? null;
      const cachedOid = extractAccountObjectId(account);
      log.info('Identity verified', { slug, user: cachedUser, object_id: cachedOid });

      await writeTokenCacheMetadataBestEffort(expectedOid, 'identity_verification');

      return {
        checked: true,
        mismatch: false,
        cached_user: cachedUser,
        cached_object_id: cachedOid,
        expected_object_id: expectedOid,
      };
    }

    case 'no_match': {
      const reason =
        accounts.length > 0 ? `TOKEN_IDENTITY_MISMATCH expected=${expectedOid} cached_count=${accounts.length}` : `No cached accounts`;
      log.warn('TOKEN_IDENTITY_MISMATCH', {
        slug,
        expected_object_id: expectedOid,
        cached_count: accounts.length,
      });

      const quarantinedPath = await quarantineTokenCache(reason);

      lastIdentityMismatchError = reason;
      msal = null;
      graph = null;
      resolvedKey = undefined;

      const firstAccount = accounts[0];
      const cachedUser = firstAccount?.username ?? null;
      const cachedOid = firstAccount ? extractAccountObjectId(firstAccount) : null;

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

    case 'multi_match': {
      const reason = `TOKEN_CACHE_CORRUPTED: ${matchResult.reason}`;
      log.error('Multiple accounts match expected OID — cache quarantined', {
        slug,
        expected_object_id: expectedOid,
        match_count: accounts.length,
      });

      const quarantinedPath = await quarantineTokenCache(reason);

      lastIdentityMismatchError = reason;
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
  }
}

// ── Auth diagnostics ────────────────────────────────────────────────────────

/**
 * Lightweight diagnostics for auth troubleshooting.
 * Does NOT throw — returns structured status even on failures.
 * Catches CONFIG_ERROR internally and reports identity_binding_status: 'missing'.
 */
export async function authStatus(): Promise<AuthStatusResult> {
  const resolvedExpectedOid = expectedObjectId();
  const oidConfigMissing = !resolvedExpectedOid;

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
    expected_object_id: resolvedExpectedOid,
    actual_object_id: null,
    identity_match: null,
    identity_binding_status: oidConfigMissing ? 'missing' : 'invalid',
  };

  if (pendingDeviceCodeInfo) {
    result.device_code_verification_uri = pendingDeviceCodeInfo.verificationUri;
    result.device_code_user_code = pendingDeviceCodeInfo.userCode;
  }

  if (oidConfigMissing) {
    result.error = 'CONFIG_ERROR: EXPECTED_AAD_OBJECT_ID is required';
    return result;
  }

  try {
    result.encryption_key_configured = getEncryptionKey() !== null;
  } catch {
    result.encryption_key_configured = false;
  }

  const cachePath = await getTokenCachePath();
  const raw = await safeReadFile(cachePath);
  result.cache_file_exists = raw !== null;

  if (raw !== null) {
    result.cache_encrypted = isEncryptedCache(raw);

    try {
      const key = getEncryptionKey();
      let json: string;
      if (key && isEncryptedCache(raw)) {
        json = decryptTokenCache(raw, key);
      } else {
        json = raw;
      }
      JSON.parse(json);
      result.cache_decryptable = true;
    } catch {
      result.cache_decryptable = false;
    }
  }

  try {
    const app = await getMsal();
    const accounts = await app.getTokenCache().getAllAccounts();
    result.account_count = accounts.length;

    if (accounts.length > 0 && resolvedExpectedOid) {
      const matchResult = findMatchingAccount(accounts, resolvedExpectedOid);

      switch (matchResult.kind) {
        case 'matched': {
          const account = matchResult.account;
          result.user = account.username ?? null;
          result.actual_object_id = extractAccountObjectId(account);
          result.identity_match = true;
          result.identity_binding_status = 'valid';
          result.logged_in = true;
          break;
        }
        case 'no_match': {
          const firstAccount = accounts[0];
          result.user = firstAccount?.username ?? null;
          result.actual_object_id = firstAccount ? extractAccountObjectId(firstAccount) : null;
          result.identity_match = false;
          result.identity_binding_status = 'invalid';
          result.error = `AUTH_MISMATCH: ${matchResult.reason}`;
          break;
        }
        case 'multi_match': {
          result.identity_match = false;
          result.identity_binding_status = 'invalid';
          result.error = `TOKEN_CACHE_CORRUPTED: ${matchResult.reason}`;
          break;
        }
      }
    } else if (accounts.length === 0) {
      result.identity_binding_status = resolvedExpectedOid ? 'valid' : 'missing';
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('CONFIG_ERROR')) {
      result.identity_binding_status = 'missing';
      result.error = msg;
    } else {
      result.error = msg;
    }
  }

  if (result.logged_in) {
    try {
      await getGraph().api('/me').select('id').get();
      result.graph_reachable = true;
    } catch (err) {
      result.graph_reachable = false;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('AUTH_EXPIRED')) {
        result.error = msg;
        result.logged_in = false;
      }
    }
  }

  return result;
}
