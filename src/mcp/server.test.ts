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

describe('MCP spec compliance — methods', () => {
  let server: http.Server;

  beforeEach(async () => {
    configApiKey = undefined;
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

  it('initialize returns protocolVersion, capabilities, serverInfo', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.1' } },
    });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, 1);
    assert.equal(parsed.result.protocolVersion, '2025-03-26');
    assert.deepEqual(parsed.result.capabilities, { tools: { listChanged: false } });
    assert.equal(parsed.result.serverInfo.name, 'm365-graph-mcp-gateway');
    assert.equal(parsed.result.serverInfo.version, '1.0.0');
  });

  it('ping returns empty result', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.id, 42);
    assert.deepEqual(parsed.result, {});
  });

  it('unknown method returns -32601 with HTTP 200', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bogus/method' });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32601);
    assert.ok(parsed.error.message.includes('bogus/method'));
  });

  it('preserves null id in response', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.id, null);
    assert.deepEqual(parsed.result, {});
  });

  it('preserves string id in response', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'req-abc', method: 'ping' });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.id, 'req-abc');
  });
});

describe('MCP spec compliance — notifications', () => {
  let server: http.Server;

  beforeEach(async () => {
    configApiKey = undefined;
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

  it('notifications/initialized returns 204 with no body', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 204);
    assert.equal(res.body, '');
  });

  it('any notification (no id) returns 204', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 204);
    assert.equal(res.body, '');
  });
});

describe('MCP spec compliance — JSON-RPC validation', () => {
  let server: http.Server;

  beforeEach(async () => {
    configApiKey = undefined;
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

  it('invalid JSON returns -32700 parse error with HTTP 200', async () => {
    const res = await makeRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32700);
    assert.equal(parsed.id, null);
  });

  it('missing jsonrpc field returns -32600', async () => {
    const body = JSON.stringify({ id: 1, method: 'ping' });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32600);
    assert.ok(parsed.error.message.includes('jsonrpc'));
  });

  it('wrong jsonrpc version returns -32600', async () => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32600);
  });

  it('non-object body (array) returns -32600', async () => {
    const body = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32600);
  });

  it('invalid id type (boolean) returns -32600', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: true, method: 'ping' });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32600);
    assert.ok(parsed.error.message.includes('id'));
  });

  it('invalid id type (object) returns -32600', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'ping' });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32600);
  });

  it('missing method field returns -32600', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1 });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32600);
    assert.ok(parsed.error.message.includes('method'));
  });

  it('non-string method returns -32600', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 123 });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32600);
  });
});
