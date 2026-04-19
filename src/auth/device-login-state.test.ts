import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

const MOCK_OID = '11111111-1111-4111-8111-111111111111';

let mockAccounts: Array<{
  homeAccountId: string;
  username: string;
  localAccountId: string;
  idTokenClaims: Record<string, unknown>;
}> = [];

let deviceCodeCallbackMessage: {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
} = {
  userCode: 'AAA111',
  verificationUri: 'https://login.microsoft.com/device',
  message: 'Use code AAA111',
  expiresIn: 1,
};

let deviceCodeResolver: (() => void) | null = null;
let startedDeviceCodeCalls = 0;

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
      retrieval: { defaultDataSource: 'sharePoint', defaultMaxResults: 10 },
      parsers: { defaultMaxChars: 50000 },
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

mock.module('./crypto.js', {
  namedExports: {
    encryptTokenCache: (plaintext: string) => plaintext,
    decryptTokenCache: (ciphertext: string) => ciphertext,
    parseEncryptionKey: () => null,
    isEncryptedCache: () => false,
  },
});

mock.module('../utils/file.js', {
  namedExports: {
    atomicWriteFile: async () => {},
    safeReadFile: async () => null,
  },
});

mock.module('@azure/msal-node', {
  namedExports: {
    PublicClientApplication: class {
      constructor() {}
      getTokenCache() {
        return {
          getAllAccounts: async () => mockAccounts,
        };
      }
      async acquireTokenByDeviceCode(request: {
        deviceCodeCallback: (msg: { userCode: string; verificationUri: string; message: string; expiresIn: number }) => void;
      }) {
        startedDeviceCodeCalls += 1;
        request.deviceCodeCallback(deviceCodeCallbackMessage);
        await new Promise<void>((resolve) => {
          deviceCodeResolver = resolve;
        });
        return {
          account: {
            homeAccountId: 'home-1',
            username: 'test@example.com',
            localAccountId: MOCK_OID,
            idTokenClaims: { oid: MOCK_OID },
          },
        };
      }
    },
    InteractionRequiredAuthError: class extends Error {},
  },
});

mock.module('open', { defaultExport: async () => {} });

const { startDeviceCodeLogin, deviceCodeLoginStatus, logout, _forcePendingDeviceCodeExpiryForTest } = await import('./index.js');

describe('device code login state', () => {
  it('expires stale pending flow and starts a new one', async () => {
    await logout();
    mockAccounts = [];
    startedDeviceCodeCalls = 0;

    deviceCodeCallbackMessage = {
      userCode: 'OLD111',
      verificationUri: 'https://login.microsoft.com/device',
      message: 'Use OLD111',
      expiresIn: 1,
    };

    const first = await startDeviceCodeLogin();
    assert.equal(first.userCode, 'OLD111');
    assert.equal(startedDeviceCodeCalls, 1);

    _forcePendingDeviceCodeExpiryForTest();
    const statusAfterExpiry = deviceCodeLoginStatus();
    assert.equal(statusAfterExpiry.pending, false);
    assert.match(statusAfterExpiry.error || '', /AUTH_EXPIRED: device code expired/);

    deviceCodeCallbackMessage = {
      userCode: 'NEW222',
      verificationUri: 'https://login.microsoft.com/device',
      message: 'Use NEW222',
      expiresIn: 900,
    };
    const second = await startDeviceCodeLogin();
    assert.equal(second.userCode, 'NEW222');
    assert.equal(startedDeviceCodeCalls, 2);

    deviceCodeResolver?.();
    await new Promise((r) => setTimeout(r, 0));
  });
});
