import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Configurable mock state ─────────────────────────────────────────────────

let mockAccounts: Array<{ homeAccountId: string; username: string }> = [];
let renameCalls: Array<{ oldPath: string; newPath: string }> = [];
let renameError: Error | null = null;

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
      server: { apiKey: undefined },
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

// Mock fs — we need to intercept fs.promises.rename for quarantine testing.
// Also mock mkdir so getTokenCachePath() doesn't hit the real filesystem.
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

// Dynamic import AFTER mocks
const { verifyIdentityBinding } = await import('./index.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  savedEnv[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear saved state
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('verifyIdentityBinding', () => {
  beforeEach(() => {
    renameCalls = [];
    renameError = null;
    mockAccounts = [];
  });

  afterEach(() => {
    restoreEnv();
  });

  it('skips check when GRAPH_MCP_EXPECTED_UPN is not set', async () => {
    setEnv('GRAPH_MCP_EXPECTED_UPN', undefined);
    mockAccounts = [{ homeAccountId: 'h1', username: 'alice@example.com' }];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, false);
    assert.equal(result.mismatch, false);
    assert.equal(result.cached_upn, null);
    assert.equal(result.expected_upn, null);
    assert.equal(renameCalls.length, 0, 'should not quarantine');
  });

  it('skips check when GRAPH_MCP_EXPECTED_UPN is empty string', async () => {
    setEnv('GRAPH_MCP_EXPECTED_UPN', '  ');
    mockAccounts = [{ homeAccountId: 'h1', username: 'alice@example.com' }];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, false);
    assert.equal(result.mismatch, false);
  });

  it('skips when expected UPN is set but no cached account', async () => {
    setEnv('GRAPH_MCP_EXPECTED_UPN', 'alice@example.com');
    mockAccounts = [];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, false);
    assert.equal(result.cached_upn, null);
    assert.equal(result.expected_upn, 'alice@example.com');
    assert.equal(renameCalls.length, 0, 'should not quarantine');
  });

  it('returns success when UPN matches (exact case)', async () => {
    setEnv('GRAPH_MCP_EXPECTED_UPN', 'alice@example.com');
    mockAccounts = [{ homeAccountId: 'h1', username: 'alice@example.com' }];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, false);
    assert.equal(result.cached_upn, 'alice@example.com');
    assert.equal(result.expected_upn, 'alice@example.com');
    assert.equal(renameCalls.length, 0, 'should not quarantine on match');
  });

  it('returns success when UPN matches (case-insensitive)', async () => {
    setEnv('GRAPH_MCP_EXPECTED_UPN', 'Alice@Example.COM');
    mockAccounts = [{ homeAccountId: 'h1', username: 'alice@example.com' }];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, false);
    assert.equal(result.cached_upn, 'alice@example.com');
    assert.equal(renameCalls.length, 0, 'should not quarantine on case-insensitive match');
  });

  it('quarantines cache on UPN mismatch', async () => {
    setEnv('GRAPH_MCP_EXPECTED_UPN', 'alice@example.com');
    setEnv('USER_SLUG', 'alice');
    mockAccounts = [{ homeAccountId: 'h1', username: 'bob@example.com' }];

    const result = await verifyIdentityBinding();

    assert.equal(result.checked, true);
    assert.equal(result.mismatch, true);
    assert.equal(result.cached_upn, 'bob@example.com');
    assert.equal(result.expected_upn, 'alice@example.com');
    assert.equal(renameCalls.length, 1, 'should quarantine the cache file');

    // Verify quarantine path format
    const call = renameCalls[0]!;
    assert.ok(call.oldPath.endsWith('token-cache.json'), `oldPath should be token-cache.json, got: ${call.oldPath}`);
    assert.ok(call.newPath.includes('.quarantined'), `newPath should contain .quarantined, got: ${call.newPath}`);
    assert.ok(result.quarantined_path?.includes('.quarantined'), 'result should include quarantined_path');
  });

  it('handles rename failure gracefully (non-ENOENT)', async () => {
    setEnv('GRAPH_MCP_EXPECTED_UPN', 'alice@example.com');
    mockAccounts = [{ homeAccountId: 'h1', username: 'bob@example.com' }];
    renameError = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

    // Should not throw — the function handles rename errors gracefully
    const result = await verifyIdentityBinding();

    assert.equal(result.mismatch, true);
    assert.equal(result.cached_upn, 'bob@example.com');
  });

  it('is idempotent — second call after quarantine finds no accounts', async () => {
    setEnv('GRAPH_MCP_EXPECTED_UPN', 'alice@example.com');
    mockAccounts = [{ homeAccountId: 'h1', username: 'bob@example.com' }];

    const first = await verifyIdentityBinding();
    assert.equal(first.mismatch, true);

    // After quarantine, MSAL state was cleared. Simulate empty cache on next boot.
    mockAccounts = [];
    renameCalls = [];

    const second = await verifyIdentityBinding();
    assert.equal(second.checked, true);
    assert.equal(second.mismatch, false);
    assert.equal(second.cached_upn, null);
    assert.equal(renameCalls.length, 0, 'should not quarantine again');
  });
});
