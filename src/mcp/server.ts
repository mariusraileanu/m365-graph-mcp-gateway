import http from 'http';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { currentUser, isLoggedIn } from '../auth/index.js';
import { tools, callTool } from '../tools/index.js';
import { loadConfig } from '../config/index.js';
import { log } from '../utils/log.js';
import type { MCPRequest, MCPResponse } from '../utils/types.js';

const MAX_REQUEST_BYTES = 1_048_576; // 1 MB

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function jsonHeaders(): Record<string, string> {
  return { ...SECURITY_HEADERS, 'Content-Type': 'application/json' };
}

async function handleRequest(request: MCPRequest): Promise<MCPResponse> {
  const { jsonrpc, id, method, params } = request;

  try {
    if (method === 'tools/list') {
      const listed = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.schema, { target: 'jsonSchema7' }),
      }));
      return { jsonrpc, id, result: { tools: listed } };
    }

    if (method === 'tools/call') {
      const toolName = String(params?.name || '');
      const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
      const result = await callTool(toolName, toolArgs);
      return { jsonrpc, id, result };
    }

    return { jsonrpc, id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (error) {
    return { jsonrpc, id, error: { code: -32000, message: error instanceof Error ? error.message : 'Unknown error' } };
  }
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
        const req = JSON.parse(line) as MCPRequest;
        handleRequest(req).then((res) => console.log(JSON.stringify(res)));
      } catch (err) {
        console.warn('stdin parse error:', err instanceof Error ? err.message : String(err));
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
      res.end(JSON.stringify({ status: 'ok', user: currentUser(), retrieval: { enabled: loadConfig().retrieval.enabled } }));
      return;
    }

    // --- Auth status (JSON API) ---
    if (req.method === 'GET' && url.pathname === '/auth/status') {
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          graph: { authenticated: isLoggedIn(), user: currentUser() },
          retrieval: { enabled: loadConfig().retrieval.enabled, dataSource: loadConfig().retrieval.dataSource },
        }),
      );
      return;
    }

    // --- MCP JSON-RPC ---
    if (req.method === 'POST' && req.url === '/mcp') {
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
          const request = JSON.parse(body) as MCPRequest;
          const response = await handleRequest(request);
          const isError = 'error' in response;
          res.writeHead(isError ? 400 : 200, jsonHeaders());
          res.end(JSON.stringify(response));
        } catch (error) {
          res.writeHead(400, jsonHeaders());
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
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
