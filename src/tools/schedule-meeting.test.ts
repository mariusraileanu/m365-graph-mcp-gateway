import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Module-level mocks ──────────────────────────────────────────────────────

const graphPostCalls: Array<{ endpoint: string; body: unknown }> = [];
let graphPostHandler: (endpoint: string, body: unknown) => unknown;
let loggedIn = true;

/** Default post handler: returns empty object */
function defaultPostHandler(_endpoint: string, _body: unknown): unknown {
  return {};
}

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
  chainable.search = () => chainable;
  chainable.query = () => chainable;
  chainable.orderby = () => chainable;
  chainable.get = async () => ({});
  chainable.post = async (body: unknown) => {
    graphPostCalls.push({ endpoint: currentEndpoint, body });
    return graphPostHandler(currentEndpoint, body);
  };
  chainable.patch = async () => ({});
  return chainable;
}

mock.module('../config/index.js', {
  namedExports: {
    loadConfig: () => ({
      azure: { clientId: 'test', tenantId: 'test' },
      scopes: ['Calendars.ReadWrite'],
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

const pickEventCalls: Array<{ event: Record<string, unknown>; includeFull: boolean }> = [];
mock.module('../graph/calendar.js', {
  namedExports: {
    pickEvent: (event: Record<string, unknown>, includeFull: boolean) => {
      pickEventCalls.push({ event, includeFull });
      return { id: event.id, subject: event.subject };
    },
    resolveTimezone: (tz?: string) => tz || 'UTC',
    calendarView: async () => [],
  },
});

mock.module('../graph/mail.js', {
  namedExports: {
    pickMail: (msg: Record<string, unknown>) => msg,
    buildMailAttachments: async () => ({ attachments: [], count: 0, totalBytes: 0 }),
    createReplyDraft: async () => ({ id: 'draft-1', source_message_id: 'msg-1', is_draft: true }),
  },
});

mock.module('../utils/log.js', {
  namedExports: {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  },
});

// ── Import tool AFTER mocks ─────────────────────────────────────────────────

const { scheduleMeetingTools } = await import('./schedule-meeting.js');
const tool = scheduleMeetingTools[0]!;

async function callSchedule(args: Record<string, unknown>) {
  return tool.run(tool.schema.parse(args));
}

function resetTracking() {
  graphPostCalls.length = 0;
  auditLogCalls.length = 0;
  pickEventCalls.length = 0;
  graphPostHandler = defaultPostHandler;
  loggedIn = true;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('schedule_meeting — explicit start/end', () => {
  beforeEach(() => resetTracking());

  it('returns preview when confirm is missing', async () => {
    const result = await callSchedule({
      subject: 'Team Standup',
      start: '2026-03-25T09:00:00+00:00',
      end: '2026-03-25T09:30:00+00:00',
    });

    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.requires_confirmation, true);
    assert.equal(sc.action, 'schedule_meeting');
    const preview = sc.preview as Record<string, unknown>;
    assert.equal(preview.subject, 'Team Standup');
    assert.equal(graphPostCalls.length, 0, 'no Graph API calls for preview');
  });

  it('creates event when confirm=true', async () => {
    graphPostHandler = (endpoint: string) => {
      if (endpoint.includes('/me/events')) {
        return { id: 'evt-new-1', subject: 'Team Standup' };
      }
      return {};
    };

    const result = await callSchedule({
      subject: 'Team Standup',
      start: '2026-03-25T09:00:00+00:00',
      end: '2026-03-25T09:30:00+00:00',
      confirm: true,
    });

    assert.ok(!('isError' in result));
    assert.equal(graphPostCalls.length, 1);
    assert.ok(graphPostCalls[0]!.endpoint.includes('/me/events'));
    const body = graphPostCalls[0]!.body as Record<string, unknown>;
    assert.equal(body.subject, 'Team Standup');
    // Verify audit
    assert.equal(auditLogCalls.length, 1);
    assert.equal(auditLogCalls[0]!.action, 'schedule_meeting');
  });

  it('passes Teams meeting flags when teams_meeting=true', async () => {
    graphPostHandler = () => ({ id: 'evt-teams', subject: 'Teams Call' });

    await callSchedule({
      subject: 'Teams Call',
      start: '2026-03-25T10:00:00+00:00',
      end: '2026-03-25T10:30:00+00:00',
      teams_meeting: true,
      confirm: true,
    });

    const body = graphPostCalls[0]!.body as Record<string, unknown>;
    assert.equal(body.isOnlineMeeting, true);
    assert.equal(body.onlineMeetingProvider, 'teamsForBusiness');
  });
});

describe('schedule_meeting — preferred window (auto free-slot)', () => {
  beforeEach(() => resetTracking());

  it('finds a free slot and creates event', async () => {
    graphPostHandler = (endpoint: string) => {
      if (endpoint.includes('getSchedule')) {
        return {
          value: [
            {
              scheduleItems: [
                // Busy 09:00-10:00 UTC, so the first free 30-min slot is at 10:00
                { start: { dateTime: '2026-03-25T09:00:00Z' }, end: { dateTime: '2026-03-25T10:00:00Z' } },
              ],
            },
          ],
        };
      }
      // /me/events creation
      return { id: 'evt-auto-1', subject: 'Auto-Scheduled' };
    };

    const result = await callSchedule({
      subject: 'Auto-Scheduled',
      preferred_start: '2026-03-25T09:00:00Z',
      preferred_end: '2026-03-25T12:00:00Z',
      duration_minutes: 30,
      confirm: true,
    });

    assert.ok(!('isError' in result));
    // First call: getSchedule, second call: create event
    assert.equal(graphPostCalls.length, 2);
    assert.ok(graphPostCalls[0]!.endpoint.includes('getSchedule'));
    assert.ok(graphPostCalls[1]!.endpoint.includes('/me/events'));

    // The event should start at 10:00 (after the busy slot)
    const eventBody = graphPostCalls[1]!.body as Record<string, unknown>;
    const start = eventBody.start as { dateTime: string };
    assert.ok(start.dateTime.includes('T10:00:00'), `expected 10:00 start, got ${start.dateTime}`);
  });

  it('returns no-free-slot when window is fully busy', async () => {
    graphPostHandler = (endpoint: string) => {
      if (endpoint.includes('getSchedule')) {
        return {
          value: [
            {
              scheduleItems: [
                // Busy for the entire 2-hour window
                { start: { dateTime: '2026-03-25T09:00:00Z' }, end: { dateTime: '2026-03-25T11:00:00Z' } },
              ],
            },
          ],
        };
      }
      return {};
    };

    const result = await callSchedule({
      subject: 'No Slot',
      preferred_start: '2026-03-25T09:00:00Z',
      preferred_end: '2026-03-25T11:00:00Z',
      duration_minutes: 60,
      confirm: true,
    });

    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.success, false);
    assert.ok(String(sc.suggestion).includes('wider'));
    // Only getSchedule called, no event creation
    assert.equal(graphPostCalls.length, 1);
  });
});

describe('schedule_meeting — validation', () => {
  beforeEach(() => resetTracking());

  it('throws VALIDATION_ERROR when no time params provided', async () => {
    await assert.rejects(() => callSchedule({ subject: 'Bad Meeting', confirm: true }), /VALIDATION_ERROR.*start\+end/);
  });

  it('throws FORBIDDEN for domain-blocked attendee', async () => {
    await assert.rejects(
      () =>
        callSchedule({
          subject: 'Blocked',
          start: '2026-03-25T09:00:00+00:00',
          end: '2026-03-25T09:30:00+00:00',
          attendees: ['alice@blocked.org'],
          confirm: true,
        }),
      /FORBIDDEN.*not in allowlist/,
    );
  });

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(
      () =>
        callSchedule({
          subject: 'Test',
          start: '2026-03-25T09:00:00+00:00',
          end: '2026-03-25T09:30:00+00:00',
        }),
      /AUTH_REQUIRED/,
    );
  });
});
