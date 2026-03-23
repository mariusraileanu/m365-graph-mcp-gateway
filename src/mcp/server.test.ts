import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

// ── Module-level mocks ──────────────────────────────────────────────────────

let configApiKey: string | undefined = undefined;
const logInfoCalls: Array<{ msg: string; data?: Record<string, unknown> }> = [];

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
    log: {
      info: (msg: string, data?: Record<string, unknown>) => {
        logInfoCalls.push({ msg, data });
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  },
});

const { startHttpServer, getHttpServer, _resetRateLimits } = await import('./server.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(
  server: http.Server,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, method: options.method, path: options.path, headers: options.headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
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
    logInfoCalls.length = 0;
    _resetRateLimits();
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
    logInfoCalls.length = 0;
    _resetRateLimits();
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
    logInfoCalls.length = 0;
    _resetRateLimits();
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
    logInfoCalls.length = 0;
    _resetRateLimits();
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

// ── Protocol version negotiation ────────────────────────────────────────────

describe('Protocol version negotiation', () => {
  let server: http.Server;

  beforeEach(async () => {
    configApiKey = undefined;
    logInfoCalls.length = 0;
    _resetRateLimits();
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

  it('accepts supported protocol version', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.1' } },
    });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.result.protocolVersion, '2025-03-26');
    assert.ok(!parsed.error);
  });

  it('rejects unsupported protocol version with -32602', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '0.1' } },
    });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, -32602);
    assert.ok(parsed.error.message.includes('2099-01-01'));
    assert.ok(parsed.error.message.includes('2025-03-26'));
  });

  it('accepts initialize without protocolVersion (permissive)', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: 'test', version: '0.1' } },
    });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.result.protocolVersion, '2025-03-26');
    assert.ok(!parsed.error);
  });

  it('accepts initialize without params (permissive)', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const res = await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.result.protocolVersion, '2025-03-26');
    assert.ok(!parsed.error);
  });
});

// ── Rate limiting ───────────────────────────────────────────────────────────

describe('Rate limiting', () => {
  let server: http.Server;

  beforeEach(async () => {
    configApiKey = undefined;
    logInfoCalls.length = 0;
    _resetRateLimits();
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

  it('returns 429 after exceeding rate limit', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const headers = { 'Content-Type': 'application/json' };

    // Send 100 requests (the limit)
    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(makeRequest(server, { method: 'POST', path: '/mcp', headers, body }));
    }
    const results = await Promise.all(promises);
    // All should succeed
    for (const r of results) {
      assert.equal(r.status, 200);
    }

    // The 101st should be rate-limited
    const limited = await makeRequest(server, { method: 'POST', path: '/mcp', headers, body });
    assert.equal(limited.status, 429);
    assert.ok(limited.body.includes('Rate limit exceeded'));
    assert.ok(limited.headers['retry-after']);
  });

  it('/health is not rate-limited', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const headers = { 'Content-Type': 'application/json' };

    // Exhaust the rate limit on /mcp
    const promises = [];
    for (let i = 0; i < 101; i++) {
      promises.push(makeRequest(server, { method: 'POST', path: '/mcp', headers, body }));
    }
    await Promise.all(promises);

    // /health should still work
    const health = await makeRequest(server, { method: 'GET', path: '/health' });
    assert.equal(health.status, 200);
  });
});

// ── Request logging ─────────────────────────────────────────────────────────

describe('Request logging', () => {
  let server: http.Server;

  beforeEach(async () => {
    configApiKey = undefined;
    logInfoCalls.length = 0;
    _resetRateLimits();
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

  it('logs method, id, duration_ms, and status for requests', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' });
    await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });

    const mcpLogs = logInfoCalls.filter((c) => c.msg === 'mcp request');
    assert.equal(mcpLogs.length, 1);
    const entry = mcpLogs[0]!.data!;
    assert.equal(entry.method, 'ping');
    assert.equal(entry.id, 99);
    assert.equal(entry.status, 'ok');
    assert.equal(typeof entry.duration_ms, 'number');
  });

  it('logs tool name for tools/call requests', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find', arguments: { query: 'test' } } });
    await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });

    const mcpLogs = logInfoCalls.filter((c) => c.msg === 'mcp request');
    assert.equal(mcpLogs.length, 1);
    assert.equal(mcpLogs[0]!.data!.tool, 'find');
  });

  it('logs error_code for error responses', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bogus/unknown' });
    await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });

    const mcpLogs = logInfoCalls.filter((c) => c.msg === 'mcp request');
    assert.equal(mcpLogs.length, 1);
    assert.equal(mcpLogs[0]!.data!.status, 'error');
    assert.equal(mcpLogs[0]!.data!.error_code, -32601);
  });

  it('does not log for notifications (no id)', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await makeRequest(server, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body });

    const mcpLogs = logInfoCalls.filter((c) => c.msg === 'mcp request');
    assert.equal(mcpLogs.length, 0);
  });
});
