import { z } from 'zod';
import { isLoggedIn, currentUser } from '../auth/index.js';
import { ok, normalizeTop, includeFull, requireConfirm } from '../utils/helpers.js';
import { graphCache } from '../utils/cache.js';
import { auditLogger } from '../utils/audit.js';
import { listChats, getChat, listChatMessages, getChatMessage, sendChatMessage, pickChat, pickMessage } from '../graph/teams.js';
import type { ToolSpec } from '../utils/types.js';

const CACHE_TTL_MS = 30_000;

export const teamsChatTools: ToolSpec[] = [
  {
    name: 'list_chats',
    description:
      'List Teams chats for the current user. Returns oneOnOne, group, and meeting chats. ' +
      'Filter by chat_type to narrow results. Meeting chats include joinWebUrl for transcript workflows.',
    schema: z
      .object({
        top: z.number().int().positive().max(50).optional(),
        chat_type: z.enum(['oneOnOne', 'group', 'meeting']).optional(),
        expand_members: z.boolean().optional(),
        include_full: z.boolean().optional(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const top = normalizeTop(params.top);
      const full = includeFull(params);
      const chatType = params.chat_type as string | undefined;
      const expandMembers = params.expand_members === true;

      const cacheKey = `chats:${chatType || 'all'}:${expandMembers}:${top}`;
      const cached = graphCache.get(cacheKey) as { chats: Record<string, unknown>[]; count: number } | undefined;
      const result = cached ?? (await listChats(top, chatType, expandMembers));
      if (!cached) graphCache.set(cacheKey, result, CACHE_TTL_MS);

      const chats = result.chats.map((c) => pickChat(c, full));
      return ok(`${chats.length} chat(s) found.`, { count: chats.length, chats });
    },
  },
  {
    name: 'get_chat',
    description:
      'Get a specific Teams chat by ID. Returns full chat details including members. ' +
      'For meeting chats, includes onlineMeetingInfo with joinWebUrl needed for resolve_meeting.',
    schema: z
      .object({
        chat_id: z.string().min(1),
        include_full: z.boolean().optional(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const chatId = String(params.chat_id);
      const full = includeFull(params);

      const cacheKey = `chat:${chatId}`;
      const cached = graphCache.get(cacheKey) as Record<string, unknown> | undefined;
      const chat = cached ?? (await getChat(chatId));
      if (!cached) graphCache.set(cacheKey, chat, CACHE_TTL_MS);

      return ok('Chat retrieved.', pickChat(chat, full));
    },
  },
  {
    name: 'list_chat_messages',
    description:
      'List messages in a Teams chat. Returns messages with sender, timestamp, and body text. ' +
      'HTML bodies are stripped to plain text and truncated.',
    schema: z
      .object({
        chat_id: z.string().min(1),
        top: z.number().int().positive().max(50).optional(),
        include_full: z.boolean().optional(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const chatId = String(params.chat_id);
      const top = normalizeTop(params.top);
      const full = includeFull(params);

      const cacheKey = `chatmsgs:${chatId}:${top}`;
      const cached = graphCache.get(cacheKey) as { messages: Record<string, unknown>[]; count: number } | undefined;
      const result = cached ?? (await listChatMessages(chatId, top));
      if (!cached) graphCache.set(cacheKey, result, CACHE_TTL_MS);

      const messages = result.messages.map((m) => pickMessage(m, full));
      return ok(`${messages.length} message(s) retrieved.`, { count: messages.length, messages });
    },
  },
  {
    name: 'get_chat_message',
    description: 'Get a specific message from a Teams chat by chat ID and message ID.',
    schema: z
      .object({
        chat_id: z.string().min(1),
        message_id: z.string().min(1),
        include_full: z.boolean().optional(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const chatId = String(params.chat_id);
      const messageId = String(params.message_id);
      const full = includeFull(params);

      const cacheKey = `chatmsg:${chatId}:${messageId}`;
      const cached = graphCache.get(cacheKey) as Record<string, unknown> | undefined;
      const message = cached ?? (await getChatMessage(chatId, messageId));
      if (!cached) graphCache.set(cacheKey, message, CACHE_TTL_MS);

      return ok('Message retrieved.', pickMessage(message, full));
    },
  },
  {
    name: 'send_chat_message',
    description:
      'Send a message to an existing Teams chat. Write operation — requires confirm=true. ' +
      'First call returns a preview; re-call with confirm=true to send. Cannot create new chats.',
    schema: z
      .object({
        chat_id: z.string().min(1),
        content: z.string().min(1),
        confirm: z.literal(true).optional(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const chatId = String(params.chat_id);
      const content = String(params.content);

      const gate = requireConfirm('send_chat_message', params, {
        chat_id: chatId,
        content_preview: content.slice(0, 200),
        content_length: content.length,
      });
      if (gate) return gate;

      const sent = await sendChatMessage(chatId, content);
      await auditLogger.log({
        action: 'send_chat_message',
        user: (await currentUser()) || 'unknown',
        details: { chat_id: chatId, content_length: content.length },
        status: 'success',
      });
      return ok('Message sent.', {
        success: true,
        message_id: sent.id,
        chat_id: chatId,
      });
    },
  },
];
