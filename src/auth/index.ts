import fs from 'fs';
import path from 'path';
import { PublicClientApplication, Configuration, InteractionRequiredAuthError, AccountInfo, DeviceCodeRequest } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import open from 'open';
import { loadConfig } from '../config/index.js';
import { resolveStoragePath } from '../utils/helpers.js';
import { log } from '../utils/log.js';
import type { LoginMode } from '../utils/types.js';

interface TokenCache {
  account: AccountInfo | null;
  accessToken: string | null;
  expiresAt: number | null;
}

const tokenCache: TokenCache = { account: null, accessToken: null, expiresAt: null };
let msal: PublicClientApplication | null = null;
let msalHydrated = false;

async function getTokenCachePath(): Promise<string> {
  const dir = resolveStoragePath(loadConfig().storage.tokenPath);
  await fs.promises.mkdir(dir, { recursive: true });
  return path.join(dir, 'token-cache.json');
}

async function getMsal(): Promise<PublicClientApplication> {
  if (msal) return msal;
  const cfg = loadConfig();
  const conf: Configuration = {
    auth: {
      clientId: cfg.azure.clientId,
      authority: `https://login.microsoftonline.com/${cfg.azure.tenantId}`,
    },
  };
  msal = new PublicClientApplication(conf);
  await hydrateMsalTokenCache(msal);
  return msal;
}

async function saveTokenCache(app?: PublicClientApplication): Promise<void> {
  const cachePath = await getTokenCachePath();
  const instance = app ?? (await getMsal());
  const serialized = instance.getTokenCache().serialize();
  await fs.promises.writeFile(cachePath, JSON.stringify({ ...tokenCache, msalCache: serialized }, null, 2), { mode: 0o600 });
}

export async function loadTokenCache(): Promise<void> {
  try {
    const cachePath = await getTokenCachePath();
    const raw = await fs.promises.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.account && parsed.accessToken && parsed.expiresAt) {
      tokenCache.account = parsed.account as AccountInfo;
      tokenCache.accessToken = String(parsed.accessToken);
      tokenCache.expiresAt = Number(parsed.expiresAt);
    }
  } catch (err) {
    console.warn('Failed to load token cache:', err instanceof Error ? err.message : String(err));
  }
}

async function hydrateMsalTokenCache(app: PublicClientApplication): Promise<void> {
  if (msalHydrated) return;
  try {
    const cachePath = await getTokenCachePath();
    const raw = await fs.promises.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.msalCache === 'string') {
      app.getTokenCache().deserialize(parsed.msalCache);
    }
  } catch (err) {
    console.warn('Failed to hydrate MSAL cache:', err instanceof Error ? err.message : String(err));
  } finally {
    msalHydrated = true;
  }
}

export function currentUser(): string | null {
  return tokenCache.account?.username ?? null;
}

export function isLoggedIn(): boolean {
  return Boolean(tokenCache.account && tokenCache.accessToken && tokenCache.expiresAt);
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
  tokenCache.account = response.account;
  tokenCache.accessToken = response.accessToken;
  tokenCache.expiresAt = response.expiresOn?.getTime() || null;
  await saveTokenCache(app);
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
  tokenCache.account = response.account;
  tokenCache.accessToken = response.accessToken;
  tokenCache.expiresAt = response.expiresOn?.getTime() || null;
  await saveTokenCache(app);
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
  tokenCache.account = null;
  tokenCache.accessToken = null;
  tokenCache.expiresAt = null;
  msalHydrated = false;
  graph = null;
  try {
    await fs.promises.unlink(await getTokenCachePath());
  } catch (err) {
    console.warn('Failed to remove token cache file:', err instanceof Error ? err.message : String(err));
  }
}

let tokenRefreshPromise: Promise<string> | null = null;

export async function getAccessToken(): Promise<string> {
  if (tokenCache.accessToken && tokenCache.expiresAt && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  // Mutex: if a refresh is already in progress, wait for it
  if (tokenRefreshPromise) return tokenRefreshPromise;

  tokenRefreshPromise = (async () => {
    try {
      await loadTokenCache();
      if (!tokenCache.account) throw new Error('AUTH_REQUIRED: not logged in, run --login first');

      const response = await (
        await getMsal()
      ).acquireTokenSilent({
        scopes: loadConfig().scopes,
        account: tokenCache.account,
      });
      tokenCache.accessToken = response.accessToken;
      tokenCache.expiresAt = response.expiresOn?.getTime() || null;
      if (response.account) tokenCache.account = response.account;
      await saveTokenCache();
      log.debug('Token refreshed', {
        user: response.account?.username,
        expiresAt: response.expiresOn?.toISOString(),
      });
      return response.accessToken;
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        log.warn('Token expired, re-authentication required');
        throw new Error('AUTH_EXPIRED: run --login to re-authenticate');
      }
      log.error('Token refresh failed', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      tokenRefreshPromise = null;
    }
  })();

  return tokenRefreshPromise;
}

let graph: Client | null = null;
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
