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
import type { LoginMode } from '../utils/types.js';

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

// ── Token cache path ────────────────────────────────────────────────────────

async function getTokenCachePath(): Promise<string> {
  const dir = resolveStoragePath(loadConfig().storage.tokenPath);
  await fs.promises.mkdir(dir, { recursive: true });
  return path.join(dir, 'token-cache.json');
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
        // Read as plaintext; it will be encrypted on next afterCacheAccess.
        log.warn('Migrating plaintext token cache to encrypted format on next write');
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
    lastKnownAccount = accounts[0] ?? null;
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

async function loginDeviceCode(): Promise<void> {
  const app = await getMsal();
  const request: DeviceCodeRequest = {
    scopes: loadConfig().scopes,
    deviceCodeCallback: (res) => {
      console.log('To sign in, open https://microsoft.com/devicelogin');
      console.log(`Enter code: ${res.userCode}`);
    },
  };
  const response = await app.acquireTokenByDeviceCode(request);
  if (!response?.account) throw new Error('LOGIN_FAILED: device code login did not return an account');
  lastKnownAccount = response.account;
  // cachePlugin.afterCacheAccess persists tokens automatically
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
  };

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
      result.logged_in = true;
      result.user = accounts[0]?.username ?? null;
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
