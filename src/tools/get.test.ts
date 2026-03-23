import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Module-level mocks (must be set up before importing get.ts) ──────────────

const graphGetCalls: Array<{ endpoint: string; headers: Record<string, string>; filter?: string }> = [];
let graphGetResponse: Record<string, unknown> | (() => Record<string, unknown>) = {};
let loggedIn = true;

// For get_file_content: mock global fetch
let fetchResponse: { ok: boolean; status: number; buffer: Buffer; contentType: string } = {
  ok: true,
  status: 200,
  buffer: Buffer.from('hello world'),
  contentType: 'text/plain',
};
const fetchCalls: Array<{ url: string }> = [];

// Override global fetch
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  fetchCalls.push({ url });
  return {
    ok: fetchResponse.ok,
    status: fetchResponse.status,
    headers: { get: (key: string) => (key === 'content-type' ? fetchResponse.contentType : null) },
    arrayBuffer: async () =>
      fetchResponse.buffer.buffer.slice(fetchResponse.buffer.byteOffset, fetchResponse.buffer.byteOffset + fetchResponse.buffer.byteLength),
  };
}) as typeof globalThis.fetch;

function createChainableClient() {
  let currentEndpoint = '';
  const headers: Record<string, string> = {};
  let currentFilter = '';
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
  chainable.filter = (f: string) => {
    currentFilter = f;
    return chainable;
  };
  chainable.get = async () => {
    graphGetCalls.push({ endpoint: currentEndpoint, headers: { ...headers }, filter: currentFilter || undefined });
    const resp = typeof graphGetResponse === 'function' ? graphGetResponse() : graphGetResponse;
    return resp;
  };
  chainable.post = async () => ({});
  chainable.patch = async () => ({});
  return chainable;
}

mock.module('../config/index.js', {
  namedExports: {
    loadConfig: () => ({
      azure: { clientId: 'test-client-id', tenantId: 'test-tenant-id' },
      scopes: ['Mail.Read'],
      guardrails: {
        email: { allowDomains: ['example.com'], requireDraftApproval: true, stripSensitiveFromLogs: false },
        audit: { enabled: false, logPath: 'audit.jsonl', retentionDays: 90 },
      },
      safety: { requireConfirmForWrites: true },
      output: { defaultIncludeFull: false, defaultMaxChars: 4000, hardMaxChars: 20000 },
      search: { defaultTop: 10, maxTop: 50 },
      calendar: { defaultTimezone: 'UTC' },
      storage: { tokenPath: 'tokens' },
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

// pickMail: capture the includeFull flag, return a deterministic shape
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

const pickFileCalls: Array<{ item: Record<string, unknown>; includeFull: boolean }> = [];
mock.module('../graph/files.js', {
  namedExports: {
    pickFile: (item: Record<string, unknown>, includeFull: boolean) => {
      pickFileCalls.push({ item, includeFull });
      return { id: item.id, name: item.name, drive_id: 'drv-1', size: item.size, web_url: item.webUrl, include_full: includeFull };
    },
    searchFiles: async () => [],
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
const getEmailThreadTool = getTools.find((t) => t.name === 'get_email_thread')!;
const getFileMetadataTool = getTools.find((t) => t.name === 'get_file_metadata')!;
const getFileContentTool = getTools.find((t) => t.name === 'get_file_content')!;

async function callGetEmail(args: Record<string, unknown>) {
  return getEmailTool.run(getEmailTool.schema.parse(args));
}

async function callGetEvent(args: Record<string, unknown>) {
  return getEventTool.run(getEventTool.schema.parse(args));
}

async function callGetEmailThread(args: Record<string, unknown>) {
  return getEmailThreadTool.run(getEmailThreadTool.schema.parse(args));
}

async function callGetFileMetadata(args: Record<string, unknown>) {
  return getFileMetadataTool.run(getFileMetadataTool.schema.parse(args));
}

async function callGetFileContent(args: Record<string, unknown>) {
  return getFileContentTool.run(getFileContentTool.schema.parse(args));
}

function resetTracking() {
  graphGetCalls.length = 0;
  pickMailCalls.length = 0;
  pickEventCalls.length = 0;
  pickFileCalls.length = 0;
  fetchCalls.length = 0;
  loggedIn = true;
  graphGetResponse = {};
  fetchResponse = { ok: true, status: 200, buffer: Buffer.from('hello world'), contentType: 'text/plain' };
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

// ── get_email_thread tests ───────────────────────────────────────────────────

describe('get_email_thread — with conversation_id', () => {
  beforeEach(() => resetTracking());

  it('fetches thread messages and returns pickMail results', async () => {
    graphGetResponse = {
      value: [
        { id: 'msg-1', subject: 'Thread start', conversationId: 'conv-abc' },
        { id: 'msg-2', subject: 'Re: Thread start', conversationId: 'conv-abc' },
      ],
    };
    const result = await callGetEmailThread({ conversation_id: 'conv-abc' });

    assert.ok(!('isError' in result));
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.conversation_id, 'conv-abc');
    assert.equal(structured.message_count, 2);
    assert.equal((structured.messages as unknown[]).length, 2);

    // Verify filter was used
    assert.equal(graphGetCalls.length, 1);
    assert.ok(graphGetCalls[0]!.filter?.includes('conv-abc'));
  });

  it('passes include_full to pickMail for each message', async () => {
    graphGetResponse = { value: [{ id: 'msg-1', subject: 'Test' }] };
    await callGetEmailThread({ conversation_id: 'conv-xyz', include_full: true });

    assert.equal(pickMailCalls.length, 1);
    assert.equal(pickMailCalls[0]!.includeFull, true);
  });
});

describe('get_email_thread — with message_id', () => {
  beforeEach(() => resetTracking());

  it('fetches conversationId from message then loads thread', async () => {
    let callCount = 0;
    graphGetResponse = () => {
      callCount++;
      if (callCount === 1) {
        // First call: fetch message to get conversationId
        return { conversationId: 'conv-resolved' };
      }
      // Second call: fetch thread
      return {
        value: [
          { id: 'msg-1', subject: 'Original' },
          { id: 'msg-2', subject: 'Reply' },
        ],
      };
    };

    const result = await callGetEmailThread({ message_id: 'msg-origin' });

    assert.ok(!('isError' in result));
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.conversation_id, 'conv-resolved');
    assert.equal(structured.message_count, 2);
    assert.equal(graphGetCalls.length, 2);
    // First call should be the message lookup
    assert.ok(graphGetCalls[0]!.endpoint.includes('/me/messages/msg-origin'));
  });

  it('throws NOT_FOUND when message has no conversationId', async () => {
    graphGetResponse = { conversationId: '' };
    await assert.rejects(() => callGetEmailThread({ message_id: 'msg-no-conv' }), /NOT_FOUND/);
  });
});

describe('get_email_thread — validation', () => {
  beforeEach(() => resetTracking());

  it('throws when neither conversation_id nor message_id provided', () => {
    assert.throws(() => getEmailThreadTool.schema.parse({}), /conversation_id.*message_id|required/i);
  });

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(() => callGetEmailThread({ conversation_id: 'conv-1' }), /AUTH_REQUIRED/);
  });
});

// ── get_file_metadata tests ──────────────────────────────────────────────────

describe('get_file_metadata', () => {
  beforeEach(() => resetTracking());

  it('fetches file metadata and returns pickFile result', async () => {
    graphGetResponse = { id: 'item-1', name: 'report.xlsx', size: 12345, webUrl: 'https://example.sharepoint.com/report.xlsx' };
    const result = await callGetFileMetadata({ drive_id: 'drv-1', item_id: 'item-1' });

    assert.ok(!('isError' in result));
    assert.equal(graphGetCalls.length, 1);
    assert.ok(graphGetCalls[0]!.endpoint.includes('/drives/drv-1/items/item-1'));
    assert.equal(pickFileCalls.length, 1);
    assert.equal(pickFileCalls[0]!.includeFull, false);
  });

  it('passes include_full=true to pickFile', async () => {
    graphGetResponse = { id: 'item-2', name: 'notes.docx', size: 500 };
    const result = await callGetFileMetadata({ drive_id: 'drv-1', item_id: 'item-2', include_full: true });

    assert.ok(!('isError' in result));
    assert.equal(pickFileCalls[0]!.includeFull, true);
  });

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(() => callGetFileMetadata({ drive_id: 'drv-1', item_id: 'item-1' }), /AUTH_REQUIRED/);
  });
});

// ── get_file_content tests ───────────────────────────────────────────────────

describe('get_file_content — text files', () => {
  beforeEach(() => resetTracking());

  it('returns text content inline for text/plain files', async () => {
    graphGetResponse = { id: 'item-1', name: 'readme.txt', size: 100, file: { mimeType: 'text/plain' } };
    fetchResponse = { ok: true, status: 200, buffer: Buffer.from('Hello, world!'), contentType: 'text/plain' };

    const result = await callGetFileContent({ drive_id: 'drv-1', item_id: 'item-1' });

    assert.ok(!('isError' in result));
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.name, 'readme.txt');
    assert.equal(structured.mime_type, 'text/plain');
    assert.equal(structured.encoding, 'text');
    assert.equal(structured.content, 'Hello, world!');
    assert.equal(structured.truncated, false);
  });

  it('returns text content for application/json files', async () => {
    graphGetResponse = { id: 'item-2', name: 'data.json', size: 50, file: { mimeType: 'application/json' } };
    fetchResponse = { ok: true, status: 200, buffer: Buffer.from('{"key":"value"}'), contentType: 'application/json' };

    const result = await callGetFileContent({ drive_id: 'drv-1', item_id: 'item-2' });

    assert.ok(!('isError' in result));
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.encoding, 'text');
    assert.equal(structured.content, '{"key":"value"}');
  });

  it('truncates text content when max_chars is set', async () => {
    const longText = 'A'.repeat(500);
    graphGetResponse = { id: 'item-3', name: 'long.txt', size: 500, file: { mimeType: 'text/plain' } };
    fetchResponse = { ok: true, status: 200, buffer: Buffer.from(longText), contentType: 'text/plain' };

    const result = await callGetFileContent({ drive_id: 'drv-1', item_id: 'item-3', max_chars: 200 });

    assert.ok(!('isError' in result));
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.truncated, true);
    assert.ok(String(structured.content).length <= 200);
  });
});

describe('get_file_content — binary files', () => {
  beforeEach(() => resetTracking());

  it('returns base64 for binary files', async () => {
    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
    graphGetResponse = { id: 'item-4', name: 'image.png', size: 4, file: { mimeType: 'image/png' } };
    fetchResponse = { ok: true, status: 200, buffer: binaryData, contentType: 'image/png' };

    const result = await callGetFileContent({ drive_id: 'drv-1', item_id: 'item-4' });

    assert.ok(!('isError' in result));
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.name, 'image.png');
    assert.equal(structured.mime_type, 'image/png');
    assert.equal(structured.encoding, 'base64');
    assert.equal(structured.content, binaryData.toString('base64'));
    assert.equal(structured.truncated, false);
  });
});

describe('get_file_content — error handling', () => {
  beforeEach(() => resetTracking());

  it('throws VALIDATION_ERROR when file exceeds size limit', async () => {
    graphGetResponse = { id: 'item-big', name: 'huge.zip', size: 11 * 1024 * 1024, file: { mimeType: 'application/zip' } };
    await assert.rejects(() => callGetFileContent({ drive_id: 'drv-1', item_id: 'item-big' }), /VALIDATION_ERROR.*exceeds/);
  });

  it('throws UPSTREAM_ERROR when download fails', async () => {
    graphGetResponse = { id: 'item-err', name: 'file.txt', size: 100, file: { mimeType: 'text/plain' } };
    fetchResponse = { ok: false, status: 404, buffer: Buffer.from(''), contentType: 'text/plain' };

    await assert.rejects(() => callGetFileContent({ drive_id: 'drv-1', item_id: 'item-err' }), /UPSTREAM_ERROR.*404/);
  });

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(() => callGetFileContent({ drive_id: 'drv-1', item_id: 'item-1' }), /AUTH_REQUIRED/);
  });
});

// Cleanup: restore global fetch
// (Not strictly necessary for test runner, but good hygiene)
// globalThis.fetch = originalFetch;
