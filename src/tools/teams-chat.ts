import { z } from 'zod';
import { normalizeTop, includeFull } from '../utils/helpers.js';
import { listChats, getChat, listChatMessages, getChatMessage, sendChatMessage, pickChat, pickMessage } from '../graph/teams.js';
import { ok, requireConfirm } from './results.js';
import { requireLoggedIn, readThroughGraphCache, GRAPH_CACHE_TTL_MS } from './shared.js';
import { writeAuditLog } from './write-audit.js';
import { defineTool } from './types.js';

export const teamsChatTools = [
  defineTool({
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
      await requireLoggedIn();
      const top = normalizeTop(params.top);
      const full = includeFull(params);
      const chatType = params.chat_type;
      const expandMembers = params.expand_members === true;

      const cacheKey = `chats:${chatType || 'all'}:${expandMembers}:${top}`;
      const result = await readThroughGraphCache(cacheKey, GRAPH_CACHE_TTL_MS, () => listChats(top, chatType, expandMembers));

      const chats = result.chats.map((c) => pickChat(c, full));
      return ok(`${chats.length} chat(s) found.`, { count: chats.length, chats });
    },
  }),
  defineTool({
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
      await requireLoggedIn();
      const chatId = params.chat_id;
      const full = includeFull(params);

      const cacheKey = `chat:${chatId}`;
      const chat = await readThroughGraphCache(cacheKey, GRAPH_CACHE_TTL_MS, () => getChat(chatId));

      return ok('Chat retrieved.', pickChat(chat, full));
    },
  }),
  defineTool({
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
      await requireLoggedIn();
      const chatId = params.chat_id;
      const top = normalizeTop(params.top);
      const full = includeFull(params);

      const cacheKey = `chatmsgs:${chatId}:${top}`;
      const result = await readThroughGraphCache(cacheKey, GRAPH_CACHE_TTL_MS, () => listChatMessages(chatId, top));

      const messages = result.messages.map((m) => pickMessage(m, full));
      return ok(`${messages.length} message(s) retrieved.`, { count: messages.length, messages });
    },
  }),
  defineTool({
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
      await requireLoggedIn();
      const chatId = params.chat_id;
      const messageId = params.message_id;
      const full = includeFull(params);

      const cacheKey = `chatmsg:${chatId}:${messageId}`;
      const message = await readThroughGraphCache(cacheKey, GRAPH_CACHE_TTL_MS, () => getChatMessage(chatId, messageId));

      return ok('Message retrieved.', pickMessage(message, full));
    },
  }),
  defineTool({
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
      await requireLoggedIn();
      const chatId = params.chat_id;
      const content = params.content;

      const gate = requireConfirm('send_chat_message', params, {
        chat_id: chatId,
        content_preview: content.slice(0, 200),
        content_length: content.length,
      });
      if (gate) return gate;

      const sent = await sendChatMessage(chatId, content);
      await writeAuditLog('send_chat_message', { chat_id: chatId, content_length: content.length });
      return ok('Message sent.', {
        success: true,
        message_id: sent.id,
        chat_id: chatId,
      });
    },
  }),
];
