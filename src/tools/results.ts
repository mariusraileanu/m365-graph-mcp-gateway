import { loadConfig } from '../config/index.js';
import type { Json, ToolFailure, ToolResult, ToolSuccess } from './types.js';

export function ok(summary: string, structuredContent: Json | Record<string, unknown>): ToolSuccess {
  return { content: [{ type: 'text', text: summary }], structuredContent };
}

export function fail(errorCode: string, message: string, details?: Record<string, unknown>): ToolFailure {
  return {
    content: [{ type: 'text', text: `${errorCode}: ${message}` }],
    structuredContent: { error_code: errorCode, message, ...(details || {}) },
    isError: true,
  };
}

export function normalizeError(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('AUTH_REQUIRED')) return { code: 'AUTH_REQUIRED', message };
  if (message.startsWith('AUTH_EXPIRED')) return { code: 'AUTH_EXPIRED', message };
  if (message.startsWith('AUTH_MISMATCH')) return { code: 'AUTH_MISMATCH', message };
  if (message.startsWith('CONFIG_ERROR')) return { code: 'CONFIG_ERROR', message };
  if (message.startsWith('VALIDATION_ERROR')) return { code: 'VALIDATION_ERROR', message };
  if (message.startsWith('FORBIDDEN')) return { code: 'FORBIDDEN', message };
  if (message.startsWith('NOT_FOUND')) return { code: 'NOT_FOUND', message };
  if (message.startsWith('UPSTREAM_ERROR')) return { code: 'UPSTREAM_ERROR', message };
  if (message.startsWith('TOKEN_CACHE_CORRUPTED')) return { code: 'TOKEN_CACHE_CORRUPTED', message };
  if (message.startsWith('FILE_TOO_LARGE')) return { code: 'FILE_TOO_LARGE', message };
  if (message.startsWith('MULTIPLE_ACCOUNTS_IN_CACHE')) return { code: 'MULTIPLE_ACCOUNTS_IN_CACHE', message };
  if (message.startsWith('CACHE_DECRYPTION_FAILED')) return { code: 'CACHE_DECRYPTION_FAILED', message };
  if (message.startsWith('MEETING_NOT_RESOLVABLE')) return { code: 'MEETING_NOT_RESOLVABLE', message };
  if (message.startsWith('MISSING_JOIN_WEB_URL')) return { code: 'MISSING_JOIN_WEB_URL', message };
  if (message.startsWith('TRANSCRIPT_NOT_AVAILABLE')) return { code: 'TRANSCRIPT_NOT_AVAILABLE', message };
  if (message.startsWith('UNSUPPORTED_FILE_TYPE')) return { code: 'UNSUPPORTED_FILE_TYPE', message };
  if (message.startsWith('PARSE_ERROR')) return { code: 'PARSE_ERROR', message };
  if (message.startsWith('INVALID_KQL_FIELD')) return { code: 'INVALID_KQL_FIELD', message };
  if (message.startsWith('INVALID_KQL_FILTER')) return { code: 'INVALID_KQL_FILTER', message };
  if (message.includes('not in allowlist')) return { code: 'FORBIDDEN', message };
  return { code: 'INTERNAL_ERROR', message };
}

export function requireConfirm<TParams extends { confirm?: boolean }>(
  action: string,
  params: TParams,
  preview: Record<string, unknown>,
): ToolResult | null {
  if (!loadConfig().safety.requireConfirmForWrites) return null;
  if (params.confirm === true) return null;
  return ok(`${action} requires explicit confirmation. Re-run with confirm=true.`, { requires_confirmation: true, action, preview });
}
