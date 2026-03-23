import http from 'http';
import crypto from 'crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { currentUser, isLoggedIn } from '../auth/index.js';
import { loadConfig } from '../config/index.js';
import { tools, callTool } from '../tools/index.js';
import { log } from '../utils/log.js';
import type { MCPRequest, MCPResponse, MCPMessage } from '../utils/types.js';

const MAX_REQUEST_BYTES = 1_048_576; // 1 MB

/** MCP protocol versions this server supports. */
const SUPPORTED_VERSIONS = ['2025-03-26'] as const;
const LATEST_VERSION = SUPPORTED_VERSIONS[0];

const SERVER_INFO = { name: 'm365-graph-mcp-gateway', version: '1.0.0' };

const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

// ── Rate limiter (sliding window) ──────────────────────────────────────────

const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateBucket {
  timestamps: number[];
}

const rateBuckets = new Map<string, RateBucket>();

/**
 * Check and record a request against the sliding-window rate limit.
 * Returns the number of seconds to wait if rate-limited, or 0 if allowed.
 */
function checkRateLimit(clientKey: string): number {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let bucket = rateBuckets.get(clientKey);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateBuckets.set(clientKey, bucket);
  }

  // Trim old entries outside the window
  bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

  if (bucket.timestamps.length >= RATE_LIMIT_MAX) {
    // Compute retry-after: time until the oldest entry in window expires
    const oldestInWindow = bucket.timestamps[0]!;
    const retryAfterMs = oldestInWindow + RATE_LIMIT_WINDOW_MS - now;
    return Math.ceil(retryAfterMs / 1000);
  }

  bucket.timestamps.push(now);
  return 0;
}

// Periodically clean up stale rate-limit buckets (every 5 minutes)
const rateLimitCleanupInterval = setInterval(
  () => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    for (const [key, bucket] of rateBuckets) {
      bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
      if (bucket.timestamps.length === 0) rateBuckets.delete(key);
    }
  },
  5 * 60 * 1000,
);
rateLimitCleanupInterval.unref();

/** Reset all rate-limit buckets. Exported for testing only. */
export function _resetRateLimits(): void {
  rateBuckets.clear();
}

// ── In-flight request tracking (for notifications/cancelled) ───────────────

const inflightRequests = new Map<string | number, AbortController>();

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonHeaders(): Record<string, string> {
  return { ...SECURITY_HEADERS, 'Content-Type': 'application/json' };
}

/**
 * Validate the API key from the Authorization header.
 * Returns true if the key is valid or if no key is configured (open access).
 * Uses constant-time comparison to prevent timing attacks.
 */
function checkApiKey(req: http.IncomingMessage): boolean {
  const expected = loadConfig().server.apiKey;
  if (!expected) return true; // no key configured → open access

  const authHeader = req.headers['authorization'] || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!provided) return false;

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf-8'), Buffer.from(provided, 'utf-8'));
  } catch {
    return false; // length mismatch
  }
}

/** Check whether a JSON-RPC id is valid per spec (string | number | null). */
function isValidId(id: unknown): id is string | number | null {
  return id === null || typeof id === 'string' || typeof id === 'number';
}

/** True if the inbound message is a notification (no `id` field). */
function isNotification(msg: MCPMessage): boolean {
  return !('id' in msg);
}

/**
 * Validate an inbound JSON-RPC 2.0 message.
 * Returns an error response if invalid, or null if valid.
 */
function validateMessage(raw: unknown): MCPResponse | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON object' } };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      id: (isValidId(obj.id) ? obj.id : null) as string | number | null,
      error: { code: -32600, message: 'Invalid Request: missing or wrong jsonrpc field (must be "2.0")' },
    };
  }

  // Notifications have no id — that's fine
  if ('id' in obj && !isValidId(obj.id)) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request: id must be a string, number, or null' },
    };
  }

  if (typeof obj.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: (isValidId(obj.id) ? obj.id : null) as string | number | null,
      error: { code: -32600, message: 'Invalid Request: method must be a string' },
    };
  }

  return null; // valid
}

/** Derive a rate-limit key from the request (IP-based). */
function rateLimitKey(req: http.IncomingMessage): string {
  // Use X-Forwarded-For if behind a proxy, otherwise remote address
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || 'unknown';
  return req.socket.remoteAddress || 'unknown';
}

// ── Request handling ───────────────────────────────────────────────────────

async function handleRequest(request: MCPRequest, signal?: AbortSignal): Promise<MCPResponse> {
  const { id, method, params } = request;

  try {
    if (method === 'initialize') {
      // Validate protocol version
      const clientVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined;
      if (clientVersion && !SUPPORTED_VERSIONS.includes(clientVersion as (typeof SUPPORTED_VERSIONS)[number])) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: `Unsupported protocol version: ${clientVersion}. Supported: ${SUPPORTED_VERSIONS.join(', ')}`,
          },
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: LATEST_VERSION,
          capabilities: SERVER_CAPABILITIES,
          serverInfo: SERVER_INFO,
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      const listed = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.schema, { target: 'jsonSchema7' }),
      }));
      return { jsonrpc: '2.0', id, result: { tools: listed } };
    }

    if (method === 'tools/call') {
      // Check if already cancelled before starting
      if (signal?.aborted) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Request cancelled' } };
      }

      const toolName = String(params?.name || '');
      const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
      const result = await callTool(toolName, toolArgs);
      return { jsonrpc: '2.0', id, result };
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error instanceof Error ? error.message : 'Unknown error' },
    };
  }
}

/**
 * Process a parsed JSON body. Returns a response to send, or null for notifications.
 */
async function processMessage(raw: unknown): Promise<MCPResponse | null> {
  // Validate structure
  const validationError = validateMessage(raw);
  if (validationError) return validationError;

  const msg = raw as MCPMessage;

  // Notifications (no id) get no response
  if (isNotification(msg)) {
    // Handle notifications/cancelled — abort in-flight request
    if (msg.method === 'notifications/cancelled') {
      const requestId = msg.params?.requestId;
      if (requestId !== undefined && requestId !== null) {
        const controller = inflightRequests.get(requestId as string | number);
        if (controller) {
          controller.abort();
          inflightRequests.delete(requestId as string | number);
        }
      }
    }
    return null;
  }

  const request = msg as MCPRequest;

  // Track in-flight request with AbortController
  const controller = new AbortController();
  const requestKey = request.id;
  if (requestKey !== null) {
    inflightRequests.set(requestKey, controller);
  }

  const start = performance.now();
  let response: MCPResponse;
  try {
    response = await handleRequest(request, controller.signal);
  } finally {
    if (requestKey !== null) {
      inflightRequests.delete(requestKey);
    }
  }
  const duration = Math.round(performance.now() - start);

  // Structured request log
  const logData: Record<string, unknown> = {
    method: request.method,
    id: request.id,
    duration_ms: duration,
    status: response.error ? 'error' : 'ok',
  };
  if (request.method === 'tools/call' && request.params?.name) {
    logData.tool = request.params.name;
  }
  if (response.error) {
    logData.error_code = response.error.code;
  }
  log.info('mcp request', logData);

  return response;
}

export function startMcpStdioServer(): void {
  let buffer = '';
  let bufferBytes = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const chunkStr = String(chunk);
    bufferBytes += Buffer.byteLength(chunkStr, 'utf8');
    if (bufferBytes > MAX_REQUEST_BYTES) {
      console.warn(`stdin buffer exceeded ${MAX_REQUEST_BYTES} bytes, discarding`);
      buffer = '';
      bufferBytes = 0;
      return;
    }
    buffer += chunkStr;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      bufferBytes = Buffer.byteLength(buffer, 'utf8');
      idx = buffer.indexOf('\n');
      if (!line) continue;
      try {
        const raw = JSON.parse(line) as unknown;
        processMessage(raw).then((res) => {
          if (res) console.log(JSON.stringify(res));
        });
      } catch {
        // Parse error — send JSON-RPC -32700
        console.log(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error: invalid JSON' },
          }),
        );
      }
    }
  });
}

let httpServer: http.Server | null = null;

export function getHttpServer(): http.Server | null {
  return httpServer;
}

export function startHttpServer(port = 3000): void {
  const host = process.env.HOST || '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // --- Health ---
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ status: 'ok', user: await currentUser() }));
      return;
    }

    // --- Auth status (JSON API) ---
    if (req.method === 'GET' && url.pathname === '/auth/status') {
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          graph: { authenticated: await isLoggedIn(), user: await currentUser() },
        }),
      );
      return;
    }

    // --- MCP JSON-RPC ---
    if (req.method === 'POST' && req.url === '/mcp') {
      // API key check — protects the tool execution endpoint
      if (!checkApiKey(req)) {
        res.writeHead(401, jsonHeaders());
        res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing API key' }));
        return;
      }

      // Rate limiting (after auth, before processing)
      const retryAfter = checkRateLimit(rateLimitKey(req));
      if (retryAfter > 0) {
        res.writeHead(429, { ...jsonHeaders(), 'Retry-After': String(retryAfter) });
        res.end(JSON.stringify({ error: `Rate limit exceeded. Try again in ${retryAfter}s.` }));
        return;
      }

      let body = '';
      let bodyBytes = 0;

      req.on('data', (chunk) => {
        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > MAX_REQUEST_BYTES) {
          res.writeHead(413, jsonHeaders());
          res.end(JSON.stringify({ error: 'Request body too large' }));
          req.destroy();
          return;
        }
        body += chunk;
      });

      req.on('error', (err) => {
        console.warn('HTTP request stream error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, jsonHeaders());
          res.end(JSON.stringify({ error: 'Stream error' }));
        }
      });

      req.on('end', async () => {
        if (res.writableEnded) return;
        try {
          const raw = JSON.parse(body) as unknown;
          const response = await processMessage(raw);
          if (response) {
            // JSON-RPC: always 200, even for method-level errors.
            // Only HTTP-level issues (auth, body-too-large) use non-200 codes.
            res.writeHead(200, jsonHeaders());
            res.end(JSON.stringify(response));
          } else {
            // Notification — no response body, 204 No Content
            res.writeHead(204, SECURITY_HEADERS);
            res.end();
          }
        } catch {
          // JSON parse failure → JSON-RPC -32700
          res.writeHead(200, jsonHeaders());
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error: invalid JSON' },
            }),
          );
        }
      });
      return;
    }

    res.writeHead(404, jsonHeaders());
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.setTimeout(180_000);
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  server.listen(port, host, () => {
    log.info('HTTP server started', {
      host,
      port,
      health: `http://${host}:${port}/health`,
      mcp: `http://${host}:${port}/mcp`,
    });
  });

  httpServer = server;
}
