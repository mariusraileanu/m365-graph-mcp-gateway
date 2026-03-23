import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Module-level mocks (must be set up before importing get.ts) ──────────────

const graphGetCalls: Array<{ endpoint: string; headers: Record<string, string> }> = [];
let graphGetResponse: Record<string, unknown> = {};
let loggedIn = true;

function createChainableClient() {
  let currentEndpoint = '';
  const headers: Record<string, string> = {};
  const chainable: Record<string, unknown> = {};
  chainable.api = (endpoint: string) => {
    currentEndpoint = endpoint;
    return chainable;
  };
  chainable.header = (key: string, value: string) => {
    headers[key] = value;
    return chainable;
  };
  chainable.select = () => chainable;
  chainable.top = () => chainable;
  chainable.orderby = () => chainable;
  chainable.search = () => chainable;
  chainable.query = () => chainable;
  chainable.get = async () => {
    graphGetCalls.push({ endpoint: currentEndpoint, headers: { ...headers } });
    return graphGetResponse;
  };
  chainable.post = async () => ({});
  chainable.patch = async () => ({});
  return chainable;
}

mock.module('../auth/index.js', {
  namedExports: {
    getGraph: () => createChainableClient(),
    isLoggedIn: async () => loggedIn,
    currentUser: async () => 'test@example.com',
    getAccessToken: async () => 'mock-token',
  },
});

// pickMail / pickEvent: capture the includeFull flag, return a deterministic shape
const pickMailCalls: Array<{ message: Record<string, unknown>; includeFull: boolean }> = [];
mock.module('../graph/mail.js', {
  namedExports: {
    pickMail: (message: Record<string, unknown>, includeFull: boolean) => {
      pickMailCalls.push({ message, includeFull });
      return { id: message.id, subject: message.subject, include_full: includeFull };
    },
    buildMailAttachments: async () => ({ attachments: [], count: 0, totalBytes: 0 }),
    createReplyDraft: async () => ({ id: 'draft-1', source_message_id: 'msg-1', is_draft: true }),
  },
});

const pickEventCalls: Array<{ event: Record<string, unknown>; includeFull: boolean }> = [];
mock.module('../graph/calendar.js', {
  namedExports: {
    pickEvent: (event: Record<string, unknown>, includeFull: boolean) => {
      pickEventCalls.push({ event, includeFull });
      return { id: event.id, subject: event.subject, include_full: includeFull };
    },
    resolveTimezone: (tz?: string) => tz || 'UTC',
    calendarView: async () => [],
  },
});

mock.module('../utils/log.js', {
  namedExports: {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  },
});

// ── Import the tools AFTER mocks ─────────────────────────────────────────────

const { getTools } = await import('./get.js');
const getEmailTool = getTools.find((t) => t.name === 'get_email')!;
const getEventTool = getTools.find((t) => t.name === 'get_event')!;

async function callGetEmail(args: Record<string, unknown>) {
  return getEmailTool.run(getEmailTool.schema.parse(args));
}

async function callGetEvent(args: Record<string, unknown>) {
  return getEventTool.run(getEventTool.schema.parse(args));
}

function resetTracking() {
  graphGetCalls.length = 0;
  pickMailCalls.length = 0;
  pickEventCalls.length = 0;
  loggedIn = true;
  graphGetResponse = {};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('get_email', () => {
  beforeEach(() => resetTracking());

  it('fetches email by ID and returns pickMail result', async () => {
    graphGetResponse = { id: 'msg-123', subject: 'Hello', bodyPreview: 'hi' };
    const result = await callGetEmail({ message_id: 'msg-123' });

    assert.ok(!('isError' in result), 'should not error');
    assert.equal(graphGetCalls.length, 1);
    assert.ok(graphGetCalls[0]!.endpoint.includes('/me/messages/msg-123'));
    assert.equal(pickMailCalls.length, 1);
    assert.equal(pickMailCalls[0]!.includeFull, false);
    assert.deepStrictEqual(result.structuredContent, { id: 'msg-123', subject: 'Hello', include_full: false });
  });

  it('passes include_full=true to pickMail', async () => {
    graphGetResponse = { id: 'msg-456', subject: 'Full' };
    const result = await callGetEmail({ message_id: 'msg-456', include_full: true });

    assert.ok(!('isError' in result));
    assert.equal(pickMailCalls[0]!.includeFull, true);
    assert.deepStrictEqual(result.structuredContent, { id: 'msg-456', subject: 'Full', include_full: true });
  });

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(() => callGetEmail({ message_id: 'msg-1' }), /AUTH_REQUIRED/);
  });
});

describe('get_event', () => {
  beforeEach(() => resetTracking());

  it('fetches event by ID with Prefer timezone header', async () => {
    graphGetResponse = { id: 'evt-789', subject: 'Meeting' };
    const result = await callGetEvent({ event_id: 'evt-789' });

    assert.ok(!('isError' in result));
    assert.equal(graphGetCalls.length, 1);
    assert.ok(graphGetCalls[0]!.endpoint.includes('/me/events/evt-789'));
    assert.ok(graphGetCalls[0]!.headers['Prefer']?.includes('outlook.timezone'));
    assert.equal(pickEventCalls.length, 1);
    assert.equal(pickEventCalls[0]!.includeFull, false);
  });

  it('passes include_full=true to pickEvent', async () => {
    graphGetResponse = { id: 'evt-abc', subject: 'Full Event' };
    const result = await callGetEvent({ event_id: 'evt-abc', include_full: true });

    assert.ok(!('isError' in result));
    assert.equal(pickEventCalls[0]!.includeFull, true);
    assert.deepStrictEqual(result.structuredContent, { id: 'evt-abc', subject: 'Full Event', include_full: true });
  });

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(() => callGetEvent({ event_id: 'evt-1' }), /AUTH_REQUIRED/);
  });
});
