import { z } from 'zod';
import { isLoggedIn, getGraph, getAccessToken } from '../auth/index.js';
import { ok, includeFull, normalizeTop, compactText, escapeODataString } from '../utils/helpers.js';
import { loadConfig } from '../config/index.js';
import { graphCache } from '../utils/cache.js';
import { pickMail } from '../graph/mail.js';
import { pickEvent, resolveTimezone } from '../graph/calendar.js';
import { pickFile } from '../graph/files.js';
import type { ToolSpec } from '../utils/types.js';

/** Cache TTL for Graph API read results (30 s). */
const CACHE_TTL_MS = 30_000;

/** Max file download size for get_file_content (10 MB). */
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

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
          .orderby('receivedDateTime asc')
          .get());

      if (!cachedResponse) graphCache.set(cacheKey, response as Record<string, unknown>, CACHE_TTL_MS);

      const messages = ((response as { value?: Array<Record<string, unknown>> }).value ?? []).map((m) => pickMail(m, full));

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
      'Returns file name, path, size, modified date, web URL, and creator info.',
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
      const item =
        cached ??
        (await getGraph()
          .api(`/drives/${driveId}/items/${itemId}`)
          .select('id,name,size,file,webUrl,lastModifiedDateTime,createdDateTime,createdBy,lastModifiedBy,parentReference')
          .get());
      if (!cached) graphCache.set(cacheKey, item as Record<string, unknown>, CACHE_TTL_MS);
      return ok('File metadata retrieved.', pickFile(item as Record<string, unknown>, includeFull(params)));
    },
  },
  {
    name: 'get_file_content',
    description:
      'Download and return the content of a OneDrive/SharePoint file. ' +
      'Text files (text/*, JSON, XML) are returned inline as text with optional truncation. ' +
      'Binary files are returned as base64. Max file size: 10 MB.',
    schema: z
      .object({
        drive_id: z.string().min(1),
        item_id: z.string().min(1),
        max_chars: z.number().int().positive().max(50000).optional(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');

      const driveId = encodeURIComponent(String(params.drive_id));
      const itemId = encodeURIComponent(String(params.item_id));

      // Step 1: Get metadata to check size and content type
      const meta = (await getGraph().api(`/drives/${driveId}/items/${itemId}`).select('id,name,size,file').get()) as Record<
        string,
        unknown
      >;

      const fileSize = Number(meta.size || 0);
      const fileName = String(meta.name || 'unknown');
      const mimeType = String((meta.file as Record<string, unknown> | undefined)?.mimeType || 'application/octet-stream');

      if (fileSize > MAX_DOWNLOAD_BYTES) {
        throw new Error(`VALIDATION_ERROR: file '${fileName}' is ${fileSize} bytes, exceeds ${MAX_DOWNLOAD_BYTES} byte limit`);
      }

      // Step 2: Download the file content
      const token = await getAccessToken();
      const endpoint = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`;
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        throw new Error(`UPSTREAM_ERROR: file download failed (${response.status})`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Step 3: Return text or base64 based on content type
      if (isTextMime(mimeType)) {
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

      // Binary file: return base64
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
