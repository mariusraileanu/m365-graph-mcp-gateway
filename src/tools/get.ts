import { z } from 'zod';
import { isLoggedIn, getGraph, getAccessToken } from '../auth/index.js';
import { ok, fail, includeFull, normalizeTop, compactText, escapeODataString } from '../utils/helpers.js';
import { loadConfig } from '../config/index.js';
import { graphCache } from '../utils/cache.js';
import { pickMail } from '../graph/mail.js';
import { pickEvent, resolveTimezone } from '../graph/calendar.js';
import { pickFile } from '../graph/files.js';
import { parseFile, isSupportedForParsing, supportedParseExtensions } from '../parsers/index.js';
import type { ToolSpec } from '../utils/types.js';

/** Cache TTL for Graph API read results (30 s). */
const CACHE_TTL_MS = 30_000;

/** Max file size for in-memory buffering (10 MB). */
const INLINE_MAX_BYTES = 10 * 1024 * 1024;

/** Max file size for parsed mode (50 MB). */
const PARSED_MAX_BYTES = 50 * 1024 * 1024;

/** MIME prefixes considered text-safe for inline return. */
const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript'];

function isTextMime(mime: string): boolean {
  return TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

export const getTools: ToolSpec[] = [
  {
    name: 'get_email',
    description: 'Get a specific email by ID. Use after find to retrieve full details.',
    schema: z.object({ message_id: z.string().min(1), include_full: z.boolean().optional() }).strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const cacheKey = `email:${params.message_id}`;
      const cached = graphCache.get(cacheKey) as Record<string, unknown> | undefined;
      const message =
        cached ??
        (await getGraph()
          .api(`/me/messages/${encodeURIComponent(String(params.message_id))}`)
          .select('id,subject,from,toRecipients,ccRecipients,bodyPreview,isRead,receivedDateTime,conversationId,webLink,body')
          .get());
      if (!cached) graphCache.set(cacheKey, message as Record<string, unknown>, CACHE_TTL_MS);
      return ok('Message retrieved.', pickMail(message as Record<string, unknown>, includeFull(params)));
    },
  },
  {
    name: 'get_event',
    description: 'Get a specific calendar event by ID. Use after find to retrieve full details.',
    schema: z.object({ event_id: z.string().min(1), include_full: z.boolean().optional() }).strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const cacheKey = `event:${params.event_id}`;
      const cached = graphCache.get(cacheKey) as Record<string, unknown> | undefined;
      const event =
        cached ??
        (await getGraph()
          .api(`/me/events/${encodeURIComponent(String(params.event_id))}`)
          .header('Prefer', `outlook.timezone="${resolveTimezone()}"`)
          .select('id,subject,start,end,location,organizer,attendees,responseStatus,isOnlineMeeting,onlineMeeting,webLink,bodyPreview')
          .get());
      if (!cached) graphCache.set(cacheKey, event as Record<string, unknown>, CACHE_TTL_MS);
      return ok('Event retrieved.', pickEvent(event as Record<string, unknown>, includeFull(params)));
    },
  },
  {
    name: 'get_email_thread',
    description:
      'Fetch all messages in an email conversation thread. ' +
      'Provide conversation_id (from get_email with include_full=true) or message_id (the tool fetches conversationId automatically). ' +
      'Returns messages sorted oldest-first.',
    schema: z
      .object({
        conversation_id: z.string().min(1).optional(),
        message_id: z.string().min(1).optional(),
        top: z.number().int().positive().max(50).optional(),
        include_full: z.boolean().optional(),
      })
      .strict()
      .refine((p) => p.conversation_id || p.message_id, {
        message: 'Either conversation_id or message_id is required',
      }),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');

      let conversationId = typeof params.conversation_id === 'string' ? params.conversation_id.trim() : '';

      // If no conversationId provided, fetch it from the message
      if (!conversationId) {
        const msg = await getGraph()
          .api(`/me/messages/${encodeURIComponent(String(params.message_id))}`)
          .select('conversationId')
          .get();
        conversationId = String((msg as Record<string, unknown>).conversationId || '').trim();
        if (!conversationId) throw new Error('NOT_FOUND: message has no conversationId');
      }

      const top = normalizeTop(params.top);
      const full = includeFull(params);

      // Only fetch body + extended fields when include_full is true to reduce payload
      const baseFields = 'id,subject,from,bodyPreview,isRead,receivedDateTime,conversationId';
      const fullFields = `${baseFields},toRecipients,ccRecipients,webLink,body`;

      // Cache keyed on conversationId + include_full + top to avoid stale partial results
      const cacheKey = `thread:${conversationId}:${full}:${top}`;
      const cachedResponse = graphCache.get(cacheKey) as { value?: Array<Record<string, unknown>> } | undefined;

      const response =
        cachedResponse ??
        (await getGraph()
          .api('/me/messages')
          .filter(`conversationId eq '${escapeODataString(conversationId)}'`)
          .select(full ? fullFields : baseFields)
          .top(top)
          .get());

      if (!cachedResponse) graphCache.set(cacheKey, response as Record<string, unknown>, CACHE_TTL_MS);

      // Sort client-side (oldest-first) — Exchange Online rejects $orderby combined with $filter on conversationId
      const messages = ((response as { value?: Array<Record<string, unknown>> }).value ?? [])
        .sort((a, b) => new Date(a.receivedDateTime as string).getTime() - new Date(b.receivedDateTime as string).getTime())
        .map((m) => pickMail(m, full));

      return ok(`Thread: ${messages.length} message(s).`, {
        conversation_id: conversationId,
        message_count: messages.length,
        messages,
      });
    },
  },
  {
    name: 'get_file_metadata',
    description:
      'Get metadata for a OneDrive/SharePoint file by drive_id and item_id (both returned by find). ' +
      'Returns file name, path, size, modified date, web URL, download URL, and creator info.',
    schema: z
      .object({
        drive_id: z.string().min(1),
        item_id: z.string().min(1),
        include_full: z.boolean().optional(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const driveId = encodeURIComponent(String(params.drive_id));
      const itemId = encodeURIComponent(String(params.item_id));
      const cacheKey = `file:${params.drive_id}:${params.item_id}`;
      const cached = graphCache.get(cacheKey) as Record<string, unknown> | undefined;
      const item = cached ?? (await getGraph().api(`/drives/${driveId}/items/${itemId}`).get());
      if (!cached) graphCache.set(cacheKey, item as Record<string, unknown>, CACHE_TTL_MS);
      return ok('File metadata retrieved.', pickFile(item as Record<string, unknown>, includeFull(params)));
    },
  },
  {
    name: 'get_file_content',
    description:
      'Access file content from OneDrive/SharePoint. ' +
      'Four modes: ' +
      'metadata (default) — returns file info + pre-authenticated download_url (valid ~1 hour), no download; ' +
      'inline — downloads and returns text content inline (text files <=10 MB only); ' +
      'binary — downloads and returns base64-encoded content (files <=10 MB only); ' +
      'parsed — downloads and extracts readable text from Office/PDF files (<=50 MB). ' +
      `Parsed mode supports: ${supportedParseExtensions().join(', ')}. ` +
      'Prefer metadata mode and let the client fetch via download_url to avoid buffering large files.',
    schema: z
      .object({
        drive_id: z.string().min(1),
        item_id: z.string().min(1),
        mode: z.enum(['metadata', 'inline', 'binary', 'parsed']).default('metadata'),
        max_chars: z.number().int().positive().max(50000).optional(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');

      const driveId = encodeURIComponent(String(params.drive_id));
      const itemId = encodeURIComponent(String(params.item_id));
      const mode = params.mode ?? 'metadata';

      // Step 1: Get metadata (includes @microsoft.graph.downloadUrl)
      const meta = (await getGraph().api(`/drives/${driveId}/items/${itemId}`).get()) as Record<string, unknown>;

      const fileSize = Number(meta.size || 0);
      const fileName = String(meta.name || 'unknown');
      const fileMeta = meta.file as Record<string, unknown> | undefined;
      const mimeType = String(fileMeta?.mimeType || 'application/octet-stream');
      const downloadUrl = (meta['@microsoft.graph.downloadUrl'] as string) || null;
      const webUrl = (meta.webUrl as string) || null;

      // ── metadata mode: return file info + download URL, no download ──
      if (mode === 'metadata') {
        return ok(`File metadata: ${fileName}`, {
          name: fileName,
          mime_type: mimeType,
          size_bytes: fileSize,
          download_url: downloadUrl,
          web_url: webUrl,
        });
      }

      // ── parsed mode: download and extract text from Office/PDF files ──
      if (mode === 'parsed') {
        if (!isSupportedForParsing(fileName)) {
          return fail('UNSUPPORTED_FILE_TYPE', `File '${fileName}' cannot be parsed. Supported: ${supportedParseExtensions().join(', ')}`, {
            name: fileName,
            mime_type: mimeType,
            download_url: downloadUrl,
            web_url: webUrl,
          });
        }

        if (fileSize > PARSED_MAX_BYTES) {
          return fail(
            'FILE_TOO_LARGE',
            `File '${fileName}' is ${fileSize} bytes (limit: ${PARSED_MAX_BYTES} for parsed mode). Use the download_url instead.`,
            { name: fileName, size_bytes: fileSize, limit_bytes: PARSED_MAX_BYTES, download_url: downloadUrl, web_url: webUrl },
          );
        }

        const token = await getAccessToken();
        const endpoint = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`;
        const dlResp = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, keepalive: true });
        if (!dlResp.ok) {
          throw new Error(`UPSTREAM_ERROR: file download failed (${dlResp.status})`);
        }

        const buffer = Buffer.from(await dlResp.arrayBuffer());
        const maxChars = typeof params.max_chars === 'number' ? params.max_chars : 50_000;
        const parsed = await parseFile(buffer, fileName, maxChars);

        return ok(`Parsed: ${fileName}`, {
          name: parsed.file_name,
          document_type: parsed.document_type,
          size_bytes: parsed.size_bytes,
          content: parsed.content,
          truncated: parsed.truncated,
          char_count: parsed.char_count,
          metadata: parsed.metadata,
          web_url: webUrl,
        });
      }

      // ── inline / binary mode: download the file content ──

      // Size guard: never buffer files >10 MB
      if (fileSize > INLINE_MAX_BYTES) {
        return fail(
          'FILE_TOO_LARGE',
          `File '${fileName}' is ${fileSize} bytes (limit: ${INLINE_MAX_BYTES}). Use the download_url instead.`,
          {
            name: fileName,
            size_bytes: fileSize,
            limit_bytes: INLINE_MAX_BYTES,
            download_url: downloadUrl,
            web_url: webUrl,
          },
        );
      }

      // For inline mode, reject non-text files
      if (mode === 'inline' && !isTextMime(mimeType)) {
        return fail('FILE_TOO_LARGE', `File '${fileName}' has non-text MIME type '${mimeType}'. Use binary mode or the download_url.`, {
          name: fileName,
          mime_type: mimeType,
          size_bytes: fileSize,
          download_url: downloadUrl,
          web_url: webUrl,
        });
      }

      // Download the file content
      const token = await getAccessToken();
      const endpoint = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`;
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, keepalive: true });
      if (!response.ok) {
        throw new Error(`UPSTREAM_ERROR: file download failed (${response.status})`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      if (mode === 'inline') {
        const maxChars = Number.parseInt(String(params.max_chars || loadConfig().output.defaultMaxChars), 10);
        const raw = buffer.toString('utf-8');
        const compact = compactText(raw, maxChars);
        return ok(`File content: ${fileName}`, {
          name: fileName,
          mime_type: mimeType,
          size_bytes: buffer.length,
          encoding: 'text',
          content: compact.text,
          truncated: compact.truncated,
        });
      }

      // binary mode
      return ok(`File content: ${fileName} (binary)`, {
        name: fileName,
        mime_type: mimeType,
        size_bytes: buffer.length,
        encoding: 'base64',
        content: buffer.toString('base64'),
        truncated: false,
      });
    },
  },
];
