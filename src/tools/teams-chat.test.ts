import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Module-level mocks ──────────────────────────────────────────────────────

const graphPostCalls: Array<{ endpoint: string; body: unknown }> = [];
let graphPostResponse: Record<string, unknown> = {};
let loggedIn = true;

function createChainableClient() {
  let currentEndpoint = '';
  const chainable: Record<string, unknown> = {};
  chainable.api = (endpoint: string) => {
    currentEndpoint = endpoint;
    return chainable;
  };
  chainable.header = () => chainable;
  chainable.select = () => chainable;
  chainable.top = () => chainable;
  chainable.filter = () => chainable;
  chainable.expand = () => chainable;
  chainable.orderby = () => chainable;
  chainable.search = () => chainable;
  chainable.query = () => chainable;
  chainable.get = async () => ({ value: [] });
  chainable.post = async (body: unknown) => {
    graphPostCalls.push({ endpoint: currentEndpoint, body });
    return graphPostResponse;
  };
  chainable.patch = async () => ({});
  return chainable;
}

mock.module('../config/index.js', {
  namedExports: {
    loadConfig: () => ({
      azure: { clientId: 'test', tenantId: 'test' },
      scopes: ['Chat.Read', 'ChatMessage.Send'],
      guardrails: {
        email: { allowDomains: ['example.com'], requireDraftApproval: true, stripSensitiveFromLogs: false },
        audit: { enabled: false, logPath: '/tmp/audit.jsonl', retentionDays: 90 },
      },
      safety: { requireConfirmForWrites: true },
      output: { defaultIncludeFull: false, defaultMaxChars: 4000, hardMaxChars: 20000 },
      search: { defaultTop: 10, maxTop: 50 },
      calendar: { defaultTimezone: 'UTC' },
      storage: { tokenPath: 'graph-mcp/tokens' },
    }),
  },
});

mock.module('../auth/index.js', {
  namedExports: {
    getGraph: () => createChainableClient(),
    isLoggedIn: async () => loggedIn,
    currentUser: async () => 'test@example.com',
    getAccessToken: async () => 'mock-token',
  },
});

const auditLogCalls: Array<Record<string, unknown>> = [];
mock.module('../utils/audit.js', {
  namedExports: {
    auditLogger: {
      log: async (entry: Record<string, unknown>) => {
        auditLogCalls.push(entry);
      },
      list: async () => [],
      init: async () => {},
    },
  },
});

mock.module('../utils/log.js', {
  namedExports: {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  },
});

// ── Graph teams mock ────────────────────────────────────────────────────────

let mockListChatsResult = { chats: [] as Record<string, unknown>[], count: 0 };
let mockGetChatResult: Record<string, unknown> = {};
let mockListMessagesResult = { messages: [] as Record<string, unknown>[], count: 0 };
let mockGetMessageResult: Record<string, unknown> = {};
let mockSendMessageResult: Record<string, unknown> = {};

mock.module('../graph/teams.js', {
  namedExports: {
    listChats: async () => mockListChatsResult,
    getChat: async () => mockGetChatResult,
    listChatMessages: async () => mockListMessagesResult,
    getChatMessage: async () => mockGetMessageResult,
    sendChatMessage: async (_chatId: string, _content: string) => {
      graphPostCalls.push({ endpoint: '/chats/mock/messages', body: { content: _content } });
      return mockSendMessageResult;
    },
    pickChat: (chat: Record<string, unknown>, _full: boolean) => ({
      id: chat.id,
      topic: chat.topic,
      chat_type: chat.chatType,
    }),
    pickMessage: (msg: Record<string, unknown>, _full: boolean) => ({
      id: msg.id,
      body_text: msg.body_text ?? 'mock text',
      from_name: msg.from_name ?? 'Test User',
    }),
  },
});

// Cache mock — avoid stale results across tests
mock.module('../utils/cache.js', {
  namedExports: {
    graphCache: {
      get: () => undefined,
      set: () => {},
      clear: () => {},
    },
  },
});

// ── Import tools AFTER mocks ────────────────────────────────────────────────

const { teamsChatTools } = await import('./teams-chat.js');

function findTool(name: string) {
  const tool = teamsChatTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const tool = findTool(name);
  return tool.run(tool.schema.parse(args));
}

function resetTracking() {
  graphPostCalls.length = 0;
  auditLogCalls.length = 0;
  graphPostResponse = {};
  loggedIn = true;
  mockListChatsResult = { chats: [], count: 0 };
  mockGetChatResult = {};
  mockListMessagesResult = { messages: [], count: 0 };
  mockGetMessageResult = {};
  mockSendMessageResult = {};
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('list_chats', () => {
  beforeEach(() => resetTracking());

  it('returns chats list', async () => {
    mockListChatsResult = {
      chats: [
        { id: 'chat-1', topic: 'General', chatType: 'group' },
        { id: 'chat-2', topic: null, chatType: 'oneOnOne' },
      ],
      count: 2,
    };
    const result = await callTool('list_chats', {});
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.count, 2);
    assert.ok(Array.isArray(sc.chats));
  });

  it('accepts chat_type filter', async () => {
    mockListChatsResult = { chats: [{ id: 'mtg-1', topic: 'Standup', chatType: 'meeting' }], count: 1 };
    const result = await callTool('list_chats', { chat_type: 'meeting' });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.count, 1);
  });

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(() => callTool('list_chats', {}), /AUTH_REQUIRED/);
  });
});

describe('get_chat', () => {
  beforeEach(() => resetTracking());

  it('returns a single chat', async () => {
    mockGetChatResult = { id: 'chat-1', topic: 'Design Review', chatType: 'group' };
    const result = await callTool('get_chat', { chat_id: 'chat-1' });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.id, 'chat-1');
  });

  it('rejects missing chat_id', async () => {
    await assert.rejects(() => callTool('get_chat', {}));
  });
});

describe('list_chat_messages', () => {
  beforeEach(() => resetTracking());

  it('returns messages', async () => {
    mockListMessagesResult = {
      messages: [
        { id: 'msg-1', body_text: 'Hello', from_name: 'Alice' },
        { id: 'msg-2', body_text: 'Hi', from_name: 'Bob' },
      ],
      count: 2,
    };
    const result = await callTool('list_chat_messages', { chat_id: 'chat-1' });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.count, 2);
  });

  it('accepts top parameter', async () => {
    mockListMessagesResult = { messages: [{ id: 'msg-1' }], count: 1 };
    const result = await callTool('list_chat_messages', { chat_id: 'chat-1', top: 5 });
    assert.ok(!('isError' in result));
  });
});

describe('get_chat_message', () => {
  beforeEach(() => resetTracking());

  it('returns a single message', async () => {
    mockGetMessageResult = { id: 'msg-42', body_text: 'Detailed message', from_name: 'Carol' };
    const result = await callTool('get_chat_message', { chat_id: 'chat-1', message_id: 'msg-42' });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.id, 'msg-42');
  });
});

describe('send_chat_message', () => {
  beforeEach(() => resetTracking());

  it('returns preview when confirm is missing', async () => {
    const result = await callTool('send_chat_message', {
      chat_id: 'chat-1',
      content: 'Hello team!',
    });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.requires_confirmation, true);
    assert.equal(sc.action, 'send_chat_message');
    assert.equal(graphPostCalls.length, 0);
  });

  it('sends message when confirm=true', async () => {
    mockSendMessageResult = { id: 'sent-msg-1' };
    const result = await callTool('send_chat_message', {
      chat_id: 'chat-1',
      content: 'Hello team!',
      confirm: true,
    });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.success, true);
    assert.equal(sc.message_id, 'sent-msg-1');
    assert.equal(graphPostCalls.length, 1);
    assert.equal(auditLogCalls.length, 1);
    assert.equal(auditLogCalls[0]!.action, 'send_chat_message');
  });

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(() => callTool('send_chat_message', { chat_id: 'chat-1', content: 'test', confirm: true }), /AUTH_REQUIRED/);
  });

  it('rejects confirm=false via z.literal(true)', async () => {
    assert.throws(() => findTool('send_chat_message').schema.parse({ chat_id: 'chat-1', content: 'test', confirm: false }));
  });
});
