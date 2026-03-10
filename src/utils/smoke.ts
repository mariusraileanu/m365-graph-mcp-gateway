/**
 * Built-in smoke test runner.
 *
 * Runs a series of HTTP calls against the local MCP server (localhost:3000)
 * and reports pass/fail for each. Designed to be invoked via:
 *
 *   node dist/index.js --smoke
 *   az containerapp exec --command "node dist/index.js --smoke"
 *
 * Uses direct console output with ANSI colors (not the structured JSON logger)
 * since this is a human-facing CLI tool.
 */

import http from 'node:http';

const BASE = 'http://127.0.0.1:3000';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passCount = 0;
let failCount = 0;
let warnCount = 0;

function log(msg: string): void {
  process.stdout.write(`\n${CYAN}▸ ${msg}${RESET}\n`);
}

function pass(label: string): void {
  passCount++;
  process.stdout.write(`  ${GREEN}✓ ${label}${RESET}\n`);
}

function fail(label: string, detail?: string): void {
  failCount++;
  process.stdout.write(`  ${RED}✗ ${label}${RESET}\n`);
  if (detail) {
    process.stdout.write(`    ${detail.slice(0, 300)}\n`);
  }
}

function warn(label: string): void {
  warnCount++;
  process.stdout.write(`  ${YELLOW}⚠ ${label}${RESET}\n`);
}

/** Make an HTTP request and return the response body as a string. */
function httpRequest(method: string, path: string, body?: string, timeoutMs = 30_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Send a JSON-RPC MCP call and return the parsed response. */
async function mcpCall(
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result: unknown; raw: string }> {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const { body } = await httpRequest('POST', '/mcp', payload);
  try {
    const json = JSON.parse(body) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
      error?: unknown;
    };
    const isErr = !!(json.result?.isError || json.error);
    return { ok: !isErr, result: json.result ?? json.error, raw: body };
  } catch {
    return { ok: false, result: null, raw: body };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertOk(label: string, result: { ok: boolean; raw: string }): void {
  if (result.ok) {
    pass(label);
  } else {
    fail(label, result.raw);
  }
}

export async function runSmoke(): Promise<void> {
  process.stdout.write(`\n${CYAN}MCP Gateway — Remote Smoke Test${RESET}\n`);

  // ── Health ──────────────────────────────────────────────
  log('Health check');
  try {
    const { status, body } = await httpRequest('GET', '/health');
    if (status === 200 && body.includes('"status"')) {
      pass('health');
      process.stdout.write(`    ${body.trim()}\n`);
    } else {
      fail('health', `status=${status} body=${body}`);
    }
  } catch (err) {
    fail('health', `Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`\n${RED}Cannot reach server at ${BASE} — is it running?${RESET}\n`);
    process.exit(1);
  }

  // ── tools/list ──────────────────────────────────────────
  log('tools/list');
  try {
    const toolsResult = await mcpCall(1, 'tools/list', {});
    assertOk('tools/list', toolsResult);
  } catch (err) {
    fail('tools/list', errMsg(err));
  }

  // ── auth whoami ─────────────────────────────────────────
  log('auth whoami');
  try {
    const authResult = await mcpCall(2, 'tools/call', {
      name: 'auth',
      arguments: { action: 'whoami' },
    });
    assertOk('auth whoami', authResult);
    if (authResult.ok) {
      const content = (authResult.result as { structuredContent?: { mail?: string; user_principal_name?: string } })?.structuredContent;
      const user = content?.mail || content?.user_principal_name || 'unknown';
      process.stdout.write(`    User: ${user}\n`);
    }
  } catch (err) {
    fail('auth whoami', errMsg(err));
  }

  // ── find mail ───────────────────────────────────────────
  log('find — mail');
  try {
    const mailResult = await mcpCall(3, 'tools/call', {
      name: 'find',
      arguments: { query: '*', entity_types: ['mail'], top: 3 },
    });
    assertOk('find mail', mailResult);
  } catch (err) {
    fail('find mail', errMsg(err));
  }

  // ── find events ─────────────────────────────────────────
  log('find — events');
  try {
    const eventsResult = await mcpCall(4, 'tools/call', {
      name: 'find',
      arguments: { query: 'meeting', entity_types: ['events'], top: 3 },
    });
    assertOk('find events', eventsResult);
  } catch (err) {
    fail('find events', errMsg(err));
  }

  // ── find files ──────────────────────────────────────────
  log('find — files');
  try {
    const filesResult = await mcpCall(5, 'tools/call', {
      name: 'find',
      arguments: { query: 'budget', entity_types: ['files'], top: 3 },
    });
    if (filesResult.ok) {
      pass('find files');
    } else {
      // Files/Copilot retrieval may not be enabled — treat as warning
      warn('find files (retrieval may not be enabled)');
    }
  } catch (err) {
    // Timeout or network error — treat as warning, not hard failure
    warn(`find files (${errMsg(err)})`);
  }

  // ── audit_list ──────────────────────────────────────────
  log('audit_list');
  try {
    const auditResult = await mcpCall(6, 'tools/call', {
      name: 'audit_list',
      arguments: { limit: 5 },
    });
    assertOk('audit_list', auditResult);
  } catch (err) {
    fail('audit_list', errMsg(err));
  }

  // ── Summary ─────────────────────────────────────────────
  process.stdout.write('\n');
  log(`Results: ${passCount} passed, ${failCount} failed, ${warnCount} warnings`);
  if (failCount === 0) {
    process.stdout.write(`${GREEN}All smoke tests passed!${RESET}\n`);
  } else {
    process.stdout.write(`${RED}Some tests failed.${RESET}\n`);
  }

  process.exit(failCount > 0 ? 1 : 0);
}
