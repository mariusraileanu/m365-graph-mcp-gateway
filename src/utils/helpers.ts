import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config/index.js';

/**
 * Validate and return USER_SLUG from the environment.
 * USER_SLUG is part of the security model — it determines cache path isolation
 * and appears in audit/log context. Required in all environments.
 */
export function requireUserSlug(): string {
  const raw = process.env.USER_SLUG;
  if (!raw) {
    throw new Error('CONFIG_ERROR: USER_SLUG is required — set it in .env (e.g. USER_SLUG=dev-local)');
  }
  const slug = raw.trim().toLowerCase();
  if (raw !== slug || !/^[a-z][a-z0-9-]{1,30}$/.test(slug)) {
    throw new Error(`INVALID_USER_SLUG: '${raw}' — must be lowercase alphanumeric + hyphens, 2-31 chars, start with letter`);
  }
  return slug;
}

export function resolveStoragePath(configPath: string): string {
  const userSlug = requireUserSlug();
  // Azure: NFS share mounted at /app/data, scoped by USER_SLUG
  if (fs.existsSync('/app/data')) {
    return path.resolve('/app/data', userSlug, configPath);
  }
  // Container without NFS mount — broken deployment
  if (fs.existsSync('/app')) {
    throw new Error('STORAGE_PATH_ERROR: /app exists but /app/data is not mounted — check NFS volume');
  }
  // Local dev: same slug-scoped layout under cwd/data/
  return path.resolve(process.cwd(), 'data', userSlug, configPath);
}

/** Escape a value for use inside an OData single-quoted string literal. */
export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

/** Normalize optional mailbox_user input for shared mailbox/calendar operations. */
export function normalizeMailboxUser(mailboxUser: unknown): string | null {
  if (mailboxUser === undefined || mailboxUser === null) return null;
  const value = String(mailboxUser).trim();
  if (!value) return null;
  if (!/^[^\s/?#]+$/.test(value)) {
    throw new Error('VALIDATION_ERROR: mailbox_user must be a UPN/email/object-id without spaces');
  }
  return value;
}

/** Build a Graph path rooted at /me or /users/{mailbox_user}. */
export function graphMailboxPath(resourcePath: string, mailboxUser?: unknown): string {
  const normalized = normalizeMailboxUser(mailboxUser);
  const suffix = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
  if (!normalized) return `/me${suffix}`;
  return `/users/${encodeURIComponent(normalized)}${suffix}`;
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

export function includeFull(params: { include_full?: boolean }): boolean {
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
