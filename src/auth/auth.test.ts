import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Module-level mocks ──────────────────────────────────────────────────────

let acquireTokenResult: Array<{ token?: string; error?: Error }> = [];
let acquireCallCount = 0;
const accounts = [{ homeAccountId: 'home-1', username: 'test@example.com' }];

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
      storage: { tokenPath: 'tokens' },
      server: { apiKey: undefined },
    }),
  },
});

mock.module('../utils/helpers.js', {
  namedExports: {
    resolveStoragePath: () => '/tmp/test-tokens',
  },
});

mock.module('../utils/log.js', {
  namedExports: {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
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
          getAllAccounts: async () => accounts,
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

// Dynamic import AFTER mocks
const { getAccessToken, isLoggedIn } = await import('./index.js');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('getAccessToken — retry logic', () => {
  beforeEach(() => {
    acquireCallCount = 0;
    acquireTokenResult = [];
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

  it('throws after both attempts fail with transient error', async () => {
    acquireTokenResult = [{ error: new Error('ECONNRESET: first') }, { error: new Error('ECONNRESET: second') }];
    await assert.rejects(() => getAccessToken(), /ECONNRESET: second/);
    assert.equal(acquireCallCount, 2, 'should attempt twice');
  });
});

describe('isLoggedIn', () => {
  it('returns true when account exists', async () => {
    assert.equal(await isLoggedIn(), true);
  });
});
