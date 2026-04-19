import { z } from 'zod';
import { getGraph } from '../auth/index.js';
import {
  includeFull,
  normalizeTop,
  compactText,
  escapeODataString,
  graphMailboxPath,
  normalizeMailboxUser,
} from '../utils/helpers.js';
import { loadConfig } from '../config/index.js';
import { pickMail } from '../graph/mail.js';
import { EVENT_FULL_SELECT, EVENT_MINIMAL_SELECT, pickEvent, resolveTimezone } from '../graph/calendar.js';
import { downloadDriveItemContent, getDriveItem, getDriveItemInfo, pickFile } from '../graph/files.js';
import { parseFile, isSupportedForParsing, supportedParseExtensions } from '../parsers/index.js';
import { ok, fail } from './results.js';
import { requireLoggedIn, readThroughGraphCache, GRAPH_CACHE_TTL_MS } from './shared.js';
import { defineTool } from './types.js';
import type {
  GraphCollectionResponse,
  GraphEvent,
  GraphMailMessage,
} from '../graph/types.js';

/** Max file size for in-memory buffering (10 MB). */
const INLINE_MAX_BYTES = 10 * 1024 * 1024;

/** Max file size for parsed mode (50 MB). */
const PARSED_MAX_BYTES = 50 * 1024 * 1024;

/** MIME prefixes considered text-safe for inline return. */
const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript'];

function isTextMime(mime: string): boolean {
  return TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

type GraphConversationLookup = {
  conversationId?: string;
};

export const getTools = [
  defineTool({
    name: 'get_email',
    description:
      'Get a specific email by ID. Use after find to retrieve full details. ' +
      'Optional mailbox_user targets a shared mailbox via /users/{mailbox_user}.',
    schema: z
      .object({ message_id: z.string().min(1), include_full: z.boolean().optional(), mailbox_user: z.string().min(1).optional() })
      .strict(),
    run: async (params) => {
      await requireLoggedIn();
      const mailboxUser = normalizeMailboxUser(params.mailbox_user);
      const cacheKey = `email:${mailboxUser || 'me'}:${params.message_id}`;
      const message = await readThroughGraphCache<GraphMailMessage>(cacheKey, GRAPH_CACHE_TTL_MS, () =>
        getGraph()
          .api(graphMailboxPath(`/messages/${encodeURIComponent(params.message_id)}`, mailboxUser))
          .select('id,subject,from,toRecipients,ccRecipients,bodyPreview,isRead,receivedDateTime,conversationId,webLink,body')
          .get(),
      );
      return ok('Message retrieved.', pickMail(message, includeFull(params)));
    },
  }),
  defineTool({
    name: 'get_event',
    description:
      'Get a specific calendar event by ID. Use after find to retrieve full details. ' +
      'Optional mailbox_user targets a shared calendar via /users/{mailbox_user}.',
    schema: z
      .object({ event_id: z.string().min(1), include_full: z.boolean().optional(), mailbox_user: z.string().min(1).optional() })
      .strict(),
    run: async (params) => {
      await requireLoggedIn();
      const mailboxUser = normalizeMailboxUser(params.mailbox_user);
      const includeFullPayload = includeFull(params);
      const cacheKey = `event:${mailboxUser || 'me'}:${params.event_id}:${includeFullPayload}`;
      const event = await readThroughGraphCache<GraphEvent>(cacheKey, GRAPH_CACHE_TTL_MS, () =>
        getGraph()
          .api(graphMailboxPath(`/events/${encodeURIComponent(params.event_id)}`, mailboxUser))
          .header('Prefer', `outlook.timezone="${resolveTimezone()}"`)
          .select(includeFullPayload ? EVENT_FULL_SELECT : EVENT_MINIMAL_SELECT)
          .get(),
      );
      return ok('Event retrieved.', pickEvent(event, includeFullPayload));
    },
  }),
  defineTool({
    name: 'get_email_thread',
    description:
      'Fetch all messages in an email conversation thread. ' +
      'Provide conversation_id (from get_email with include_full=true) or message_id (the tool fetches conversationId automatically). ' +
      'Returns messages sorted oldest-first. Optional mailbox_user targets a shared mailbox.',
    schema: z
      .object({
        conversation_id: z.string().min(1).optional(),
        message_id: z.string().min(1).optional(),
        mailbox_user: z.string().min(1).optional(),
        top: z.number().int().positive().max(50).optional(),
        include_full: z.boolean().optional(),
      })
      .strict()
      .refine((p) => p.conversation_id || p.message_id, {
        message: 'Either conversation_id or message_id is required',
      }),
    run: async (params) => {
      await requireLoggedIn();
      const mailboxUser = normalizeMailboxUser(params.mailbox_user);

      let conversationId = params.conversation_id?.trim() ?? '';

      // If no conversationId provided, fetch it from the message
      if (!conversationId) {
        const msg: GraphConversationLookup = await getGraph()
          .api(graphMailboxPath(`/messages/${encodeURIComponent(params.message_id!)}`, mailboxUser))
          .select('conversationId')
          .get();
        conversationId = String(msg.conversationId || '').trim();
        if (!conversationId) throw new Error('NOT_FOUND: message has no conversationId');
      }

      const top = normalizeTop(params.top);
      const full = includeFull(params);

      // Only fetch body + extended fields when include_full is true to reduce payload
      const baseFields = 'id,subject,from,bodyPreview,isRead,receivedDateTime,conversationId';
      const fullFields = `${baseFields},toRecipients,ccRecipients,webLink,body`;

      // Cache keyed on conversationId + include_full + top to avoid stale partial results
      const cacheKey = `thread:${mailboxUser || 'me'}:${conversationId}:${full}:${top}`;
      const response = await readThroughGraphCache<GraphCollectionResponse<GraphMailMessage>>(cacheKey, GRAPH_CACHE_TTL_MS, () =>
        getGraph()
          .api(graphMailboxPath('/messages', mailboxUser))
          .filter(`conversationId eq '${escapeODataString(conversationId)}'`)
          .select(full ? fullFields : baseFields)
          .top(top)
          .get(),
      );

      // Sort client-side (oldest-first) — Exchange Online rejects $orderby combined with $filter on conversationId
      const messages = (response.value ?? [])
        .sort(
          (a, b) =>
            new Date(String(a.receivedDateTime ?? '')).getTime() - new Date(String(b.receivedDateTime ?? '')).getTime(),
        )
        .map((m) => pickMail(m, full));

      return ok(`Thread: ${messages.length} message(s).`, {
        ...(mailboxUser ? { mailbox_user: mailboxUser } : {}),
        conversation_id: conversationId,
        message_count: messages.length,
        messages,
      });
    },
  }),
  defineTool({
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
      await requireLoggedIn();
      const cacheKey = `file:${params.drive_id}:${params.item_id}`;
      const item = await readThroughGraphCache(cacheKey, GRAPH_CACHE_TTL_MS, () => getDriveItem(params.drive_id, params.item_id));
      return ok('File metadata retrieved.', pickFile(item, includeFull(params)));
    },
  }),
  defineTool({
    name: 'get_file_content',
    description:
      'Access file content from OneDrive/SharePoint. ' +
      'Four modes: ' +
      'parsed — extracts readable text from Office/PDF files (<=50 MB). ' +
      `USE THIS MODE when the user wants to read, summarise, or analyse file content. Supports: ${supportedParseExtensions().join(', ')}. ` +
      'metadata — returns file info + pre-authenticated download_url (valid ~1 hour), no content downloaded. ' +
      'Use when only a link or file properties are needed. ' +
      'inline — downloads and returns text content inline (plain-text files <=10 MB only). ' +
      'binary — downloads and returns base64-encoded content (files <=10 MB only).',
    schema: z
      .object({
        drive_id: z.string().min(1),
        item_id: z.string().min(1),
        mode: z.enum(['metadata', 'inline', 'binary', 'parsed']).default('metadata'),
        max_chars: z.number().int().positive().max(50000).optional(),
      })
      .strict(),
    run: async (params) => {
      await requireLoggedIn();

      const driveId = params.drive_id;
      const itemId = params.item_id;
      const mode = params.mode ?? 'metadata';

      const meta = await readThroughGraphCache(`file:${params.drive_id}:${params.item_id}`, GRAPH_CACHE_TTL_MS, () => getDriveItem(driveId, itemId));
      const { size: fileSize, name: fileName, mimeType, downloadUrl, webUrl } = getDriveItemInfo(meta);

      if (mode === 'metadata') {
        return ok(`File metadata: ${fileName}`, {
          name: fileName,
          mime_type: mimeType,
          size_bytes: fileSize,
          download_url: downloadUrl,
          web_url: webUrl,
        });
      }

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

        const buffer = await downloadDriveItemContent(driveId, itemId);
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

      if (mode === 'inline' && !isTextMime(mimeType)) {
        return fail('FILE_TOO_LARGE', `File '${fileName}' has non-text MIME type '${mimeType}'. Use binary mode or the download_url.`, {
          name: fileName,
          mime_type: mimeType,
          size_bytes: fileSize,
          download_url: downloadUrl,
          web_url: webUrl,
        });
      }

      const buffer = await downloadDriveItemContent(driveId, itemId);

      if (mode === 'inline') {
        const maxChars = params.max_chars ?? loadConfig().output.defaultMaxChars;
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

      return ok(`File content: ${fileName} (binary)`, {
        name: fileName,
        mime_type: mimeType,
        size_bytes: buffer.length,
        encoding: 'base64',
        content: buffer.toString('base64'),
        truncated: false,
      });
    },
  }),
];
