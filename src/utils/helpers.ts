import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config/index.js';
import type { Json, ToolSuccess, ToolFailure, ToolResult } from './types.js';

export function resolveStoragePath(configPath: string): string {
  const userSlug = process.env.USER_SLUG;
  // Azure: NFS share mounted at /app/data, scoped by USER_SLUG
  if (userSlug && fs.existsSync('/app/data')) {
    return path.resolve('/app/data', userSlug, configPath);
  }
  // Docker / bare container: /app exists but no USER_SLUG
  if (fs.existsSync('/app')) {
    return path.resolve('/app', configPath);
  }
  // Local dev
  return path.resolve(process.cwd(), 'data', configPath);
}

export function sanitizeForLogs(content: string): string {
  if (!loadConfig().guardrails.email.stripSensitiveFromLogs) return content;
  return content
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL_REDACTED]')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE_REDACTED]')
    .replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '[CARD_REDACTED]');
}

export function compactText(text: string, maxChars?: number): { text: string; truncated: boolean } {
  const cfg = loadConfig();
  const safeMax = Math.max(200, Math.min(maxChars ?? cfg.output.defaultMaxChars, cfg.output.hardMaxChars));
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const short = normalized.slice(0, safeMax);
  return { text: short, truncated: normalized.length > short.length };
}

export function normalizeTop(top: unknown): number {
  const cfg = loadConfig();
  const value = Number.parseInt(String(top ?? cfg.search.defaultTop), 10);
  if (Number.isNaN(value)) return cfg.search.defaultTop;
  return Math.max(1, Math.min(value, cfg.search.maxTop));
}

export function includeFull(params: Record<string, unknown>): boolean {
  if (typeof params.include_full === 'boolean') return params.include_full;
  return loadConfig().output.defaultIncludeFull;
}

export function checkEmailAllowed(recipient: string): { allowed: boolean; reason?: string } {
  const domain = recipient.split('@')[1]?.toLowerCase();
  if (!domain) return { allowed: false, reason: 'Invalid email address' };
  const patterns = loadConfig().guardrails.email.allowDomains.map((d) => d.toLowerCase());
  const match = patterns.some((p) => {
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".example.com"
      return domain === p.slice(2) || domain.endsWith(suffix);
    }
    return domain === p;
  });
  if (!match) {
    return { allowed: false, reason: `Domain @${domain} is not in allowlist` };
  }
  return { allowed: true };
}

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
  if (message.includes('not in allowlist')) return { code: 'FORBIDDEN', message };
  if (message.includes('required')) return { code: 'VALIDATION_ERROR', message };
  if (message.includes('not found')) return { code: 'NOT_FOUND', message };
  if (message.includes('Graph') || message.includes('graph')) return { code: 'UPSTREAM_ERROR', message };
  return { code: 'INTERNAL_ERROR', message };
}

export function requireConfirm(action: string, params: Record<string, unknown>, preview: Record<string, unknown>): ToolResult | null {
  if (!loadConfig().safety.requireConfirmForWrites) return null;
  if (params.confirm === true) return null;
  return ok(`${action} requires explicit confirmation. Re-run with confirm=true.`, { requires_confirmation: true, action, preview });
}

export function parseRecipients(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((x) => String(x).trim()).filter(Boolean);
  }
  return String(input ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Strip dangerous HTML tags and attributes while preserving safe formatting. */
export function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/<link[\s\S]*?>/gi, '')
    .replace(/<meta[\s\S]*?>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, 'blocked:');
}
