import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Module-level mocks ──────────────────────────────────────────────────────

let loggedIn = true;

function createChainableClient() {
  const chainable: Record<string, unknown> = {};
  chainable.api = () => chainable;
  chainable.header = () => chainable;
  chainable.select = () => chainable;
  chainable.top = () => chainable;
  chainable.filter = () => chainable;
  chainable.expand = () => chainable;
  chainable.orderby = () => chainable;
  chainable.query = () => chainable;
  chainable.get = async () => ({ value: [] });
  chainable.post = async () => ({});
  chainable.patch = async () => ({});
  return chainable;
}

mock.module('../config/index.js', {
  namedExports: {
    loadConfig: () => ({
      azure: { clientId: 'test', tenantId: 'test' },
      scopes: ['OnlineMeetingTranscript.Read.All', 'OnlineMeetings.Read'],
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

mock.module('../utils/audit.js', {
  namedExports: {
    auditLogger: {
      log: async () => {},
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

let mockResolveMeetingResult: Record<string, unknown> | null = null;
let mockListTranscriptsResult = { transcripts: [] as Record<string, unknown>[], count: 0 };
let mockGetTranscriptResult: Record<string, unknown> = {};
let mockGetTranscriptContentResult = '';
let mockResolveMeetingError: Error | null = null;
let mockListTranscriptsError: Error | null = null;
let mockGetTranscriptError: Error | null = null;
let mockGetTranscriptContentError: Error | null = null;

mock.module('../graph/teams.js', {
  namedExports: {
    resolveMeeting: async () => {
      if (mockResolveMeetingError) throw mockResolveMeetingError;
      return mockResolveMeetingResult;
    },
    listMeetingTranscripts: async () => {
      if (mockListTranscriptsError) throw mockListTranscriptsError;
      return mockListTranscriptsResult;
    },
    getMeetingTranscript: async () => {
      if (mockGetTranscriptError) throw mockGetTranscriptError;
      return mockGetTranscriptResult;
    },
    getTranscriptContent: async () => {
      if (mockGetTranscriptContentError) throw mockGetTranscriptContentError;
      return mockGetTranscriptContentResult;
    },
    pickTranscript: (t: Record<string, unknown>) => ({
      id: t.id,
      meeting_id: t.meetingId,
      created_at: t.createdDateTime,
    }),
    pickChat: (c: Record<string, unknown>) => c,
    pickMessage: (m: Record<string, unknown>) => m,
    listChats: async () => ({ chats: [], count: 0 }),
    getChat: async () => ({}),
    listChatMessages: async () => ({ messages: [], count: 0 }),
    getChatMessage: async () => ({}),
    sendChatMessage: async () => ({}),
  },
});

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

const { teamsMeetingTools } = await import('./teams-meeting.js');

function findTool(name: string) {
  const tool = teamsMeetingTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const tool = findTool(name);
  return tool.run(tool.schema.parse(args));
}

function resetTracking() {
  loggedIn = true;
  mockResolveMeetingResult = null;
  mockListTranscriptsResult = { transcripts: [], count: 0 };
  mockGetTranscriptResult = {};
  mockGetTranscriptContentResult = '';
  mockResolveMeetingError = null;
  mockListTranscriptsError = null;
  mockGetTranscriptError = null;
  mockGetTranscriptContentError = null;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('resolve_meeting', () => {
  beforeEach(() => resetTracking());

  it('resolves a meeting from joinWebUrl', async () => {
    mockResolveMeetingResult = {
      id: 'meeting-123',
      subject: 'Sprint Review',
      startDateTime: '2025-01-01T10:00:00Z',
      endDateTime: '2025-01-01T11:00:00Z',
      joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
    };
    const result = await callTool('resolve_meeting', {
      join_web_url: 'https://teams.microsoft.com/l/meetup-join/abc',
    });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.meeting_id, 'meeting-123');
    assert.equal(sc.subject, 'Sprint Review');
  });

  it('returns MEETING_NOT_RESOLVABLE when no meeting found', async () => {
    mockResolveMeetingResult = null;
    const result = await callTool('resolve_meeting', {
      join_web_url: 'https://teams.microsoft.com/l/meetup-join/expired',
    });
    assert.ok('isError' in result);
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.error_code, 'MEETING_NOT_RESOLVABLE');
  });

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(
      () => callTool('resolve_meeting', { join_web_url: 'https://teams.microsoft.com/l/meetup-join/abc' }),
      /AUTH_REQUIRED/,
    );
  });

  it('rejects invalid URL', () => {
    assert.throws(() => findTool('resolve_meeting').schema.parse({ join_web_url: 'not-a-url' }));
  });
});

describe('list_meeting_transcripts', () => {
  beforeEach(() => resetTracking());

  it('returns transcripts list', async () => {
    mockListTranscriptsResult = {
      transcripts: [
        { id: 'trans-1', meetingId: 'meeting-1', createdDateTime: '2025-01-01T12:00:00Z' },
        { id: 'trans-2', meetingId: 'meeting-1', createdDateTime: '2025-01-01T13:00:00Z' },
      ],
      count: 2,
    };
    const result = await callTool('list_meeting_transcripts', { meeting_id: 'meeting-1' });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.available, true);
    assert.equal(sc.count, 2);
  });

  it('returns available=false when transcription not enabled (404)', async () => {
    mockListTranscriptsError = new Error('Graph request failed: 404 not found');
    const result = await callTool('list_meeting_transcripts', { meeting_id: 'meeting-404' });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.available, false);
    assert.equal(sc.reason, 'transcription_not_enabled');
  });

  it('returns available=false when no permission (403)', async () => {
    mockListTranscriptsError = new Error('Graph request failed: 403 Forbidden');
    const result = await callTool('list_meeting_transcripts', { meeting_id: 'meeting-403' });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.available, false);
    assert.equal(sc.reason, 'no_permission');
  });

  it('returns available=false when meeting expired (410)', async () => {
    mockListTranscriptsError = new Error('Graph request failed: 410 Gone');
    const result = await callTool('list_meeting_transcripts', { meeting_id: 'meeting-410' });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.available, false);
    assert.equal(sc.reason, 'meeting_expired');
  });

  it('re-throws unexpected errors', async () => {
    mockListTranscriptsError = new Error('UPSTREAM_ERROR: network timeout');
    await assert.rejects(() => callTool('list_meeting_transcripts', { meeting_id: 'meeting-x' }), /UPSTREAM_ERROR/);
  });
});

describe('get_meeting_transcript', () => {
  beforeEach(() => resetTracking());

  it('returns transcript metadata', async () => {
    mockGetTranscriptResult = { id: 'trans-1', meetingId: 'meeting-1', createdDateTime: '2025-01-01T12:00:00Z' };
    const result = await callTool('get_meeting_transcript', {
      meeting_id: 'meeting-1',
      transcript_id: 'trans-1',
    });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.id, 'trans-1');
  });

  it('returns available=false on 404', async () => {
    mockGetTranscriptError = new Error('404 not found');
    const result = await callTool('get_meeting_transcript', {
      meeting_id: 'meeting-1',
      transcript_id: 'trans-missing',
    });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.available, false);
  });
});

describe('get_transcript_content', () => {
  beforeEach(() => resetTracking());

  it('returns WebVTT content', async () => {
    mockGetTranscriptContentResult = 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n<v Alice>Hello everyone\n';
    const result = await callTool('get_transcript_content', {
      meeting_id: 'meeting-1',
      transcript_id: 'trans-1',
    });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.available, true);
    assert.equal(sc.format, 'text/vtt');
    assert.ok(String(sc.content).startsWith('WEBVTT'));
  });

  it('returns available=false on 403', async () => {
    mockGetTranscriptContentError = new Error('403 Forbidden');
    const result = await callTool('get_transcript_content', {
      meeting_id: 'meeting-1',
      transcript_id: 'trans-1',
    });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.available, false);
    assert.equal(sc.reason, 'no_permission');
  });

  it('accepts max_chars parameter', async () => {
    mockGetTranscriptContentResult = 'WEBVTT\n\n' + 'A'.repeat(10000);
    const result = await callTool('get_transcript_content', {
      meeting_id: 'meeting-1',
      transcript_id: 'trans-1',
      max_chars: 500,
    });
    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.truncated, true);
    assert.ok(String(sc.content).length <= 500);
  });

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(() => callTool('get_transcript_content', { meeting_id: 'm', transcript_id: 't' }), /AUTH_REQUIRED/);
  });
});
