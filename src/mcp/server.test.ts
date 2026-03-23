import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

// ── Module-level mocks ──────────────────────────────────────────────────────

let configApiKey: string | undefined = undefined;

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
      server: {
        get apiKey() {
          return configApiKey;
        },
      },
    }),
  },
});

mock.module('../auth/index.js', {
  namedExports: {
    isLoggedIn: async () => true,
    currentUser: async () => 'test@example.com',
    getAccessToken: async () => 'mock-token',
    getGraph: () => ({}),
  },
});

mock.module('../tools/index.js', {
  namedExports: {
    tools: [],
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: {} }),
  },
});

mock.module('../utils/log.js', {
  namedExports: {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  },
});

const { startHttpServer, getHttpServer } = await import('./server.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(
  server: http.Server,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, method: options.method, path: options.path, headers: options.headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const VALID_MCP_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

// ── Tests ───────────────────────────────────────────────────────────────────

describe('HTTP server — API key auth', () => {
  let server: http.Server;

  beforeEach(async () => {
    configApiKey = undefined;
    // Start on random port
    startHttpServer(0);
    server = getHttpServer()!;
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.on('listening', resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('/health is accessible without API key', async () => {
    configApiKey = 'secret-key';
    const res = await makeRequest(server, { method: 'GET', path: '/health' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, 'ok');
  });

  it('/auth/status is accessible without API key', async () => {
    configApiKey = 'secret-key';
    const res = await makeRequest(server, { method: 'GET', path: '/auth/status' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.graph.authenticated, true);
  });

  it('/mcp returns 401 when key is configured but not provided', async () => {
    configApiKey = 'secret-key';
    const res = await makeRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
      body: VALID_MCP_BODY,
    });
    assert.equal(res.status, 401);
    assert.ok(res.body.includes('Unauthorized'));
  });

  it('/mcp returns 401 when wrong key is provided', async () => {
    configApiKey = 'secret-key';
    const res = await makeRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-key' },
      body: VALID_MCP_BODY,
    });
    assert.equal(res.status, 401);
  });

  it('/mcp succeeds with correct API key', async () => {
    configApiKey = 'secret-key';
    const res = await makeRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-key' },
      body: VALID_MCP_BODY,
    });
    assert.equal(res.status, 200);
  });

  it('/mcp succeeds without key when none is configured (open access)', async () => {
    configApiKey = undefined;
    const res = await makeRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
      body: VALID_MCP_BODY,
    });
    assert.equal(res.status, 200);
  });

  it('/mcp succeeds when configured key is empty string (open access)', async () => {
    configApiKey = '';
    const res = await makeRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
      body: VALID_MCP_BODY,
    });
    assert.equal(res.status, 200);
  });
});
