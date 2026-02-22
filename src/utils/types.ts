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

export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
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
