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
let atomicWriteCalls: Array<{ filePath: string; content: string }> = [];

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
    atomicWriteFile: async (filePath: string, content: string) => {
      atomicWriteCalls.push({ filePath, content });
    },
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

describe('verifyIdentityBinding (OID-based matching)', () => {
  beforeEach(() => {
    renameCalls = [];
    renameError = null;
    mockAccounts = [];
    atomicWriteCalls = [];
    expectedObjectIdEnv = undefined;
  });

  afterEach(() => {
    expectedObjectIdEnv = undefined;
  });

  it('throws CONFIG_ERROR when EXPECTED_AAD_OBJECT_ID is not set', async () => {
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'alice@example.com',
        localAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    ];

    await assert.rejects(() => verifyIdentityBinding(), /CONFIG_ERROR/);
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
    assert.ok(result.reason?.includes('TOKEN_IDENTITY_MISMATCH'));
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

  it('selects correct account when multiple accounts exist with one match', async () => {
    expectedObjectIdEnv = '11111111-1111-4111-8111-111111111111';
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'wrong@example.com',
        localAccountId: '99999999-9999-4999-8999-999999999999',
        idTokenClaims: { oid: '99999999-9999-4999-8999-999999999999' },
      },
      {
        homeAccountId: 'h2',
        username: 'correct@example.com',
        localAccountId: '11111111-1111-4111-8111-111111111111',
        idTokenClaims: { oid: '11111111-1111-4111-8111-111111111111' },
      },
    ];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, false);
    assert.equal(result.cached_user, 'correct@example.com');
    assert.equal(result.cached_object_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(renameCalls.length, 0);
  });

  it('quarantines when multiple accounts exist and none match', async () => {
    expectedObjectIdEnv = '11111111-1111-4111-8111-111111111111';
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'alice@example.com',
        localAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        idTokenClaims: { oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      },
      {
        homeAccountId: 'h2',
        username: 'bob@example.com',
        localAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        idTokenClaims: { oid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      },
    ];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, true);
    assert.equal(renameCalls.length, 1);
    assert.ok(result.reason?.includes('TOKEN_IDENTITY_MISMATCH'));
  });

  it('quarantines when multiple accounts match the same OID (corrupted cache)', async () => {
    expectedObjectIdEnv = '11111111-1111-4111-8111-111111111111';
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'alice@example.com',
        localAccountId: '11111111-1111-4111-8111-111111111111',
        idTokenClaims: { oid: '11111111-1111-4111-8111-111111111111' },
      },
      {
        homeAccountId: 'h2',
        username: 'alice-dup@example.com',
        localAccountId: '11111111-1111-4111-8111-111111111111',
        idTokenClaims: { oid: '11111111-1111-4111-8111-111111111111' },
      },
    ];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, true);
    assert.equal(renameCalls.length, 1);
    assert.ok(result.reason?.includes('TOKEN_CACHE_CORRUPTED'));
  });

  it('writes metadata file on successful verification', async () => {
    expectedObjectIdEnv = '11111111-1111-4111-8111-111111111111';
    mockAccounts = [
      {
        homeAccountId: 'h1',
        username: 'alice@example.com',
        localAccountId: '11111111-1111-4111-8111-111111111111',
        idTokenClaims: { oid: '11111111-1111-4111-8111-111111111111' },
      },
    ];

    await verifyIdentityBinding();

    // Should have written metadata file
    const metaWrite = atomicWriteCalls.find((c) => c.filePath.includes('token-cache.meta.json'));
    assert.ok(metaWrite, 'should write token-cache.meta.json');
    const metadata = JSON.parse(metaWrite.content);
    assert.equal(metadata.expected_aad_object_id, '11111111-1111-4111-8111-111111111111');
    assert.ok(metadata.created_at);
    assert.ok(metadata.last_validated_at);
  });

  it('skips gracefully with no cached accounts', async () => {
    expectedObjectIdEnv = '11111111-1111-4111-8111-111111111111';
    mockAccounts = [];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, false);
    assert.equal(result.cached_user, null);
    assert.equal(result.expected_object_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(renameCalls.length, 0);
  });
});
