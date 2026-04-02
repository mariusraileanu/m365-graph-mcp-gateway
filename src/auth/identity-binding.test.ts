import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let mockAccounts: Array<{
  homeAccountId: string;
  username: string;
  localAccountId?: string;
  idTokenClaims?: Record<string, unknown>;
}> = [];
let renameCalls: Array<{ oldPath: string; newPath: string }> = [];
let renameError: Error | null = null;
let expectedObjectIdEnv: string | undefined;

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
      server: {
        apiKey: undefined,
        get expectedAadObjectId() {
          return expectedObjectIdEnv;
        },
      },
    }),
  },
});

mock.module('../utils/helpers.js', {
  namedExports: {
    resolveStoragePath: () => '/tmp/test-identity-tokens',
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

mock.module('fs', {
  defaultExport: {
    existsSync: () => false,
    promises: {
      mkdir: async () => {},
      rename: async (oldPath: string, newPath: string) => {
        if (renameError) throw renameError;
        renameCalls.push({ oldPath, newPath });
      },
      unlink: async () => {},
    },
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
      async acquireTokenSilent() {
        return { accessToken: 'test-token' };
      }
    },
    InteractionRequiredAuthError: class extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'InteractionRequiredAuthError';
      }
    },
  },
});

mock.module('open', { defaultExport: async () => {} });

mock.module('../mcp/server.js', {
  namedExports: {
    sendNotification: () => {},
  },
});

const { verifyIdentityBinding } = await import('./index.js');

describe('verifyIdentityBinding (object-id mode)', () => {
  beforeEach(() => {
    renameCalls = [];
    renameError = null;
    mockAccounts = [];
    expectedObjectIdEnv = undefined;
  });

  afterEach(() => {
    expectedObjectIdEnv = undefined;
  });

  it('skips check when EXPECTED_AAD_OBJECT_ID is not set', async () => {
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'alice@example.com',
        localAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    ];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, false);
    assert.equal(result.mismatch, false);
    assert.equal(result.expected_object_id, null);
    assert.equal(renameCalls.length, 0);
  });

  it('passes when claim oid matches expected object id', async () => {
    expectedObjectIdEnv = '11111111-1111-4111-8111-111111111111';
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'alice@example.com',
        localAccountId: '22222222-2222-4222-8222-222222222222',
        idTokenClaims: { oid: '11111111-1111-4111-8111-111111111111' },
      },
    ];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, false);
    assert.equal(result.expected_object_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(result.cached_object_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(renameCalls.length, 0);
  });

  it('falls back to localAccountId when oid claim is missing', async () => {
    expectedObjectIdEnv = '33333333-3333-4333-8333-333333333333';
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'alice@example.com',
        localAccountId: '33333333-3333-4333-8333-333333333333',
      },
    ];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, false);
    assert.equal(result.cached_object_id, '33333333-3333-4333-8333-333333333333');
    assert.equal(renameCalls.length, 0);
  });

  it('quarantines cache when object id mismatches', async () => {
    expectedObjectIdEnv = '44444444-4444-4444-8444-444444444444';
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'bob@example.com',
        localAccountId: '55555555-5555-4555-8555-555555555555',
        idTokenClaims: { oid: '55555555-5555-4555-8555-555555555555' },
      },
    ];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, true);
    assert.equal(result.expected_object_id, '44444444-4444-4444-8444-444444444444');
    assert.equal(result.cached_object_id, '55555555-5555-4555-8555-555555555555');
    assert.equal(renameCalls.length, 1);
    assert.ok(result.reason?.includes('TOKEN_IDENTITY_MISMATCH'));
  });

  it('quarantines cache when object id cannot be extracted', async () => {
    expectedObjectIdEnv = '66666666-6666-4666-8666-666666666666';
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'bob@example.com',
        localAccountId: 'not-a-uuid',
        idTokenClaims: { oid: 'still-not-a-uuid' },
      },
    ];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, true);
    assert.equal(result.cached_object_id, null);
    assert.equal(renameCalls.length, 1);
    assert.ok(result.reason?.includes('TOKEN_IDENTITY_UNKNOWN'));
  });

  it('handles rename failure gracefully', async () => {
    expectedObjectIdEnv = '77777777-7777-4777-8777-777777777777';
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'bob@example.com',
        localAccountId: '88888888-8888-4888-8888-888888888888',
      },
    ];
    renameError = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

    const result = await verifyIdentityBinding();

    assert.equal(result.mismatch, true);
    assert.equal(result.cached_user, 'bob@example.com');
  });
});
