import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Configurable mock state ─────────────────────────────────────────────────

let acquireTokenResult: Array<{ token?: string; error?: Error }> = [];
let acquireCallCount = 0;
const MOCK_OID = '11111111-1111-4111-8111-111111111111';
let mockAccounts: Array<{
  homeAccountId: string;
  username: string;
  localAccountId: string;
  idTokenClaims: Record<string, unknown>;
}> = [{ homeAccountId: 'home-1', username: 'test@example.com', localAccountId: MOCK_OID, idTokenClaims: { oid: MOCK_OID } }];

// ── Module-level mocks (before dynamic import) ─────────────────────────────

mock.module('../config/index.js', {
  namedExports: {
    loadConfig: () => ({
      azure: { clientId: 'test-client-id', tenantId: 'test-tenant-id' },
      scopes: ['Mail.Read'],
      guardrails: {
        email: { allowDomains: ['example.com'], requireDraftApproval: true, stripSensitiveFromLogs: false },
        audit: { enabled: false, logPath: 'audit.jsonl', retentionDays: 90 },
      },
      safety: { requireConfirmForWrites: true },
      output: { defaultIncludeFull: false, defaultMaxChars: 4000, hardMaxChars: 20000 },
      search: { defaultTop: 10, maxTop: 50 },
      calendar: { defaultTimezone: 'UTC' },
      storage: { tokenPath: 'tokens', encryptionKey: '' },
      server: { apiKey: undefined, expectedAadObjectId: MOCK_OID },
    }),
  },
});

mock.module('../utils/helpers.js', {
  namedExports: {
    resolveStoragePath: () => '/tmp/test-tokens',
    requireUserSlug: () => 'test-user',
  },
});

mock.module('../utils/log.js', {
  namedExports: {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  },
});

// Mock crypto module — bypass actual encryption in auth module tests
mock.module('./crypto.js', {
  namedExports: {
    encryptTokenCache: (plaintext: string) => plaintext,
    decryptTokenCache: (ciphertext: string) => ciphertext,
    parseEncryptionKey: () => null,
    isEncryptedCache: () => false,
  },
});

// Mock file helpers — no real filesystem in auth logic tests
mock.module('../utils/file.js', {
  namedExports: {
    atomicWriteFile: async () => {},
    safeReadFile: async () => null,
  },
});

// Mock @azure/msal-node
const InteractionRequiredAuthErrorMock = class extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'InteractionRequiredAuthError';
  }
};

mock.module('@azure/msal-node', {
  namedExports: {
    PublicClientApplication: class {
      constructor() {}
      getTokenCache() {
        return {
          getAllAccounts: async () => mockAccounts,
        };
      }
      async acquireTokenSilent() {
        const idx = acquireCallCount++;
        const entry = acquireTokenResult[idx] ?? acquireTokenResult[acquireTokenResult.length - 1];
        if (entry?.error) throw entry.error;
        return { accessToken: entry?.token || 'default-token' };
      }
    },
    InteractionRequiredAuthError: InteractionRequiredAuthErrorMock,
  },
});

mock.module('open', { defaultExport: async () => {} });

// Mock MCP server module — sendNotification is a no-op in tests
mock.module('../mcp/server.js', {
  namedExports: {
    sendNotification: () => {},
  },
});

// Dynamic import AFTER mocks
const { getAccessToken, isLoggedIn, currentUser } = await import('./index.js');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('resolveAccount — OID-based matching', () => {
  beforeEach(() => {
    acquireCallCount = 0;
    acquireTokenResult = [];
  });

  it('returns user when account OID matches expected', async () => {
    mockAccounts = [{ homeAccountId: 'home-1', username: 'test@example.com', localAccountId: MOCK_OID, idTokenClaims: { oid: MOCK_OID } }];
    assert.equal(await isLoggedIn(), true);
    assert.equal(await currentUser(), 'test@example.com');
  });

  it('returns null / false when zero accounts in cache', async () => {
    mockAccounts = [];
    assert.equal(await isLoggedIn(), false);
    assert.equal(await currentUser(), null);
  });

  it('selects matching account when multiple accounts exist', async () => {
    mockAccounts = [
      {
        homeAccountId: 'home-1',
        username: 'alice@example.com',
        localAccountId: '99999999-9999-4999-8999-999999999999',
        idTokenClaims: { oid: '99999999-9999-4999-8999-999999999999' },
      },
      {
        homeAccountId: 'home-2',
        username: 'bob@example.com',
        localAccountId: MOCK_OID,
        idTokenClaims: { oid: MOCK_OID },
      },
    ];
    assert.equal(await isLoggedIn(), true);
    assert.equal(await currentUser(), 'bob@example.com');
  });

  it('returns null when no account OID matches (quarantines cache)', async () => {
    mockAccounts = [
      {
        homeAccountId: 'home-1',
        username: 'alice@example.com',
        localAccountId: '99999999-9999-4999-8999-999999999999',
        idTokenClaims: { oid: '99999999-9999-4999-8999-999999999999' },
      },
    ];
    assert.equal(await isLoggedIn(), false);
    assert.equal(await currentUser(), null);
  });

  it('throws AUTH_REQUIRED from getAccessToken when zero accounts', async () => {
    mockAccounts = [];
    await assert.rejects(() => getAccessToken(), /AUTH_REQUIRED/);
  });
});

describe('getAccessToken — retry logic', () => {
  beforeEach(() => {
    acquireCallCount = 0;
    acquireTokenResult = [];
    mockAccounts = [{ homeAccountId: 'home-1', username: 'test@example.com', localAccountId: MOCK_OID, idTokenClaims: { oid: MOCK_OID } }];
  });

  it('returns token on first successful attempt', async () => {
    acquireTokenResult = [{ token: 'abc-123' }];
    const token = await getAccessToken();
    assert.equal(token, 'abc-123');
    assert.equal(acquireCallCount, 1, 'should only call acquireTokenSilent once');
  });

  it('retries once on transient error and succeeds', async () => {
    acquireTokenResult = [{ error: new Error('ECONNRESET: network hiccup') }, { token: 'retry-token' }];
    const token = await getAccessToken();
    assert.equal(token, 'retry-token');
    assert.equal(acquireCallCount, 2, 'should retry once');
  });

  it('throws AUTH_EXPIRED immediately for InteractionRequiredAuthError (no retry)', async () => {
    acquireTokenResult = [{ error: new InteractionRequiredAuthErrorMock('interaction_required') }];
    await assert.rejects(() => getAccessToken(), /AUTH_EXPIRED/);
    assert.equal(acquireCallCount, 1, 'should NOT retry InteractionRequiredAuthError');
  });

  it('throws AUTH_EXPIRED immediately for AADSTS70043 invalid_grant (no retry)', async () => {
    acquireTokenResult = [
      {
        error: new Error(
          'invalid_grant: Error(s): 70043 - AADSTS70043: The refresh token has expired or is invalid due to sign-in frequency checks by conditional access.',
        ),
      },
    ];
    await assert.rejects(() => getAccessToken(), /AUTH_EXPIRED/);
    assert.equal(acquireCallCount, 1, 'should NOT retry invalid_grant');
  });

  it('throws AUTH_EXPIRED for plain invalid_grant without AADSTS70043', async () => {
    acquireTokenResult = [{ error: new Error('invalid_grant: token was revoked') }];
    await assert.rejects(() => getAccessToken(), /AUTH_EXPIRED/);
    assert.equal(acquireCallCount, 1, 'should NOT retry invalid_grant');
  });

  it('throws after both attempts fail with transient error', async () => {
    acquireTokenResult = [{ error: new Error('ECONNRESET: first') }, { error: new Error('ECONNRESET: second') }];
    await assert.rejects(() => getAccessToken(), /ECONNRESET: second/);
    assert.equal(acquireCallCount, 2, 'should attempt twice');
  });
});
