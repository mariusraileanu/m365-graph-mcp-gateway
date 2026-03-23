import { z } from 'zod';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type ContentBlock = { type: 'text'; text: string };

export interface ToolSuccess {
  content: ContentBlock[];
  structuredContent: Json | Record<string, unknown>;
}

export interface ToolFailure {
  content: ContentBlock[];
  structuredContent: Record<string, unknown>;
  isError: true;
}

export type ToolResult = ToolSuccess | ToolFailure;

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  run: (params: Record<string, unknown>) => Promise<ToolResult>;
}

/** JSON-RPC 2.0 request (has id — expects a response). */
export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 notification (no id — no response expected). */
export interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/** Inbound JSON-RPC message — either a request or a notification. */
export type MCPMessage = MCPRequest | MCPNotification;

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type LoginMode = 'interactive' | 'device';

export type GraphFileAttachment = {
  '@odata.type': '#microsoft.graph.fileAttachment';
  name: string;
  contentType: string;
  contentBytes: string;
};

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  user: string;
  details: Record<string, unknown>;
  status: 'success' | 'blocked' | 'error';
  error?: string;
}
