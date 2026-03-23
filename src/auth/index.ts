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
import type { LoginMode } from '../utils/types.js';

let msal: PublicClientApplication | null = null;
let graph: Client | null = null;

// Last known account — updated by resolveAccount(), login flows, logout.
// Callers that need guaranteed-fresh state should call isLoggedIn() or
// getAccessToken() first (both trigger beforeCacheAccess → disk read).
let lastKnownAccount: AccountInfo | null = null;

async function getTokenCachePath(): Promise<string> {
  const dir = resolveStoragePath(loadConfig().storage.tokenPath);
  await fs.promises.mkdir(dir, { recursive: true });
  return path.join(dir, 'token-cache.json');
}

function createCachePlugin(): ICachePlugin {
  return {
    async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
      const cachePath = await getTokenCachePath();
      const data = await fs.promises.readFile(cachePath, 'utf-8').catch(() => null);
      if (data) {
        ctx.tokenCache.deserialize(data);
      }
    },
    async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
      if (ctx.cacheHasChanged) {
        const cachePath = await getTokenCachePath();
        await fs.promises.writeFile(cachePath, ctx.tokenCache.serialize(), { mode: 0o600 });
      }
    },
  };
}

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

function pickAccount(accounts: AccountInfo[]): AccountInfo | null {
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0] ?? null;

  // Prefer the last-known account if it's still present in the cache
  if (lastKnownAccount) {
    const match = accounts.find((a) => a.homeAccountId === lastKnownAccount?.homeAccountId);
    if (match) return match;
  }

  return accounts[0] ?? null;
}

async function resolveAccount(): Promise<AccountInfo | null> {
  const app = await getMsal();
  const accounts = await app.getTokenCache().getAllAccounts();
  lastKnownAccount = pickAccount(accounts);
  return lastKnownAccount;
}

export async function currentUser(): Promise<string | null> {
  const account = await resolveAccount();
  return account?.username ?? null;
}

export async function isLoggedIn(): Promise<boolean> {
  const account = await resolveAccount();
  return account !== null;
}

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
  if (!response?.account) throw new Error('Login failed');
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

  if (!response?.account) throw new Error('Login failed');
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

export async function logout(): Promise<void> {
  lastKnownAccount = null;
  msal = null;
  graph = null;
  try {
    await fs.promises.unlink(await getTokenCachePath());
  } catch (err) {
    log.warn('Failed to remove token cache file', { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function getAccessToken(): Promise<string> {
  const app = await getMsal();
  const account = await resolveAccount();

  if (!account) {
    throw new Error('AUTH_REQUIRED: not logged in, run --login first');
  }

  try {
    const response = await app.acquireTokenSilent({
      scopes: loadConfig().scopes,
      account,
    });
    return response.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      log.warn('Token expired, re-authentication required');
      throw new Error('AUTH_EXPIRED: run --login to re-authenticate');
    }
    log.error('Token refresh failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

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
    });
  }
  return graph;
}
