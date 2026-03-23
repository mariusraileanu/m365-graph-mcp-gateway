import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Module-level mocks ──────────────────────────────────────────────────────

const graphGetCalls: Array<{ endpoint: string }> = [];
const graphPostCalls: Array<{ endpoint: string; body: unknown }> = [];
const graphPatchCalls: Array<{ endpoint: string; body: unknown }> = [];
let graphGetHandler: (endpoint: string) => unknown;
let graphPostHandler: (endpoint: string, body: unknown) => unknown;
let loggedIn = true;

function defaultGetHandler(_endpoint: string): unknown {
  return {};
}
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
  chainable.get = async () => {
    graphGetCalls.push({ endpoint: currentEndpoint });
    return graphGetHandler(currentEndpoint);
  };
  chainable.post = async (body: unknown) => {
    graphPostCalls.push({ endpoint: currentEndpoint, body });
    return graphPostHandler(currentEndpoint, body);
  };
  chainable.patch = async (body: unknown) => {
    graphPatchCalls.push({ endpoint: currentEndpoint, body });
    return {};
  };
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

mock.module('../graph/calendar.js', {
  namedExports: {
    pickEvent: (e: Record<string, unknown>) => e,
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

const { respondMeetingTools } = await import('./respond-meeting.js');
const tool = respondMeetingTools[0]!;

async function callRespond(args: Record<string, unknown>) {
  return tool.run(tool.schema.parse(args));
}

function resetTracking() {
  graphGetCalls.length = 0;
  graphPostCalls.length = 0;
  graphPatchCalls.length = 0;
  auditLogCalls.length = 0;
  graphGetHandler = defaultGetHandler;
  graphPostHandler = defaultPostHandler;
  loggedIn = true;
}

// ── Tests — RSVP actions ────────────────────────────────────────────────────

describe('respond_to_meeting — RSVP', () => {
  beforeEach(() => resetTracking());

  it('returns preview when confirm is missing (accept)', async () => {
    const result = await callRespond({ event_id: 'evt-1', action: 'accept' });

    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.requires_confirmation, true);
    assert.equal(sc.action, 'respond_to_meeting');
    assert.equal(graphPostCalls.length, 0, 'no Graph API call for preview');
  });

  it('sends accept when confirm=true', async () => {
    const result = await callRespond({ event_id: 'evt-1', action: 'accept', confirm: true });

    assert.ok(!('isError' in result));
    assert.equal(graphPostCalls.length, 1);
    assert.ok(graphPostCalls[0]!.endpoint.includes('/me/events/evt-1/accept'));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.success, true);
    assert.equal(sc.action, 'accept');
  });

  it('sends decline when confirm=true', async () => {
    const result = await callRespond({ event_id: 'evt-2', action: 'decline', confirm: true });

    assert.ok(!('isError' in result));
    assert.ok(graphPostCalls[0]!.endpoint.includes('/me/events/evt-2/decline'));
  });

  it('sends tentativelyAccept when confirm=true', async () => {
    const result = await callRespond({ event_id: 'evt-3', action: 'tentativelyAccept', confirm: true });

    assert.ok(!('isError' in result));
    assert.ok(graphPostCalls[0]!.endpoint.includes('/me/events/evt-3/tentativelyAccept'));
  });

  it('includes comment in RSVP payload', async () => {
    await callRespond({ event_id: 'evt-4', action: 'accept', comment: 'Will be 5 min late', confirm: true });

    const body = graphPostCalls[0]!.body as Record<string, unknown>;
    assert.equal(body.comment, 'Will be 5 min late');
  });
});

// ── Tests — cancel ──────────────────────────────────────────────────────────

describe('respond_to_meeting — cancel', () => {
  beforeEach(() => resetTracking());

  it('returns preview when confirm is missing', async () => {
    const result = await callRespond({ event_id: 'evt-5', action: 'cancel' });

    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.requires_confirmation, true);
    assert.equal(sc.action, 'respond_to_meeting (cancel)');
  });

  it('cancels meeting when confirm=true', async () => {
    const result = await callRespond({ event_id: 'evt-5', action: 'cancel', confirm: true });

    assert.ok(!('isError' in result));
    assert.equal(graphPostCalls.length, 1);
    assert.ok(graphPostCalls[0]!.endpoint.includes('/me/events/evt-5/cancel'));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.success, true);
  });

  it('passes comment to cancel POST body', async () => {
    await callRespond({ event_id: 'evt-6', action: 'cancel', comment: 'Rescheduling', confirm: true });

    const body = graphPostCalls[0]!.body as Record<string, unknown>;
    assert.deepStrictEqual(body, { comment: 'Rescheduling' });
  });
});

// ── Tests — reply_all_draft ─────────────────────────────────────────────────

describe('respond_to_meeting — reply_all_draft', () => {
  beforeEach(() => resetTracking());

  it('creates reply-all draft from meeting invite', async () => {
    graphGetHandler = (endpoint: string) => {
      // GET event
      if (endpoint.includes('/me/events/evt-10')) {
        return {
          id: 'evt-10',
          subject: 'Team Sync',
          organizer: { emailAddress: { address: 'org@example.com', name: 'Organizer' } },
        };
      }
      // Search messages (for invite)
      if (endpoint.includes('/me/messages')) {
        return { value: [{ id: 'msg-invite-1', subject: 'Team Sync' }] };
      }
      return {};
    };

    graphPostHandler = (endpoint: string) => {
      // createReplyAll
      if (endpoint.includes('createReplyAll')) {
        return { id: 'draft-ra-1' };
      }
      return {};
    };

    const result = await callRespond({ event_id: 'evt-10', action: 'reply_all_draft' });

    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.id, 'draft-ra-1');
    assert.equal(sc.source_message_id, 'msg-invite-1');
    assert.equal(sc.is_draft, true);
    // Verify audit
    assert.equal(auditLogCalls.length, 1);
    assert.equal(auditLogCalls[0]!.action, 'respond_to_meeting_reply_all_draft');
  });

  it('patches body_html into the reply-all draft', async () => {
    graphGetHandler = (endpoint: string) => {
      if (endpoint.includes('/me/events/evt-11')) {
        return {
          id: 'evt-11',
          subject: 'Planning',
          organizer: { emailAddress: { address: 'boss@example.com' } },
        };
      }
      if (endpoint.includes('/me/messages') && !endpoint.includes('createReplyAll')) {
        // If fetching draft body
        if (endpoint.includes('draft-ra-2')) {
          return { body: { content: '<p>Original reply content</p>' } };
        }
        // Search for invite message
        return { value: [{ id: 'msg-invite-2', subject: 'Planning' }] };
      }
      return {};
    };

    graphPostHandler = (endpoint: string) => {
      if (endpoint.includes('createReplyAll')) {
        return { id: 'draft-ra-2' };
      }
      return {};
    };

    const result = await callRespond({
      event_id: 'evt-11',
      action: 'reply_all_draft',
      body_html: '<p>Adding agenda notes</p>',
    });

    assert.ok(!('isError' in result));
    // Should have patched the draft with merged body
    assert.equal(graphPatchCalls.length, 1);
    const patchBody = graphPatchCalls[0]!.body as { body: { contentType: string; content: string } };
    assert.equal(patchBody.body.contentType, 'HTML');
    assert.ok(patchBody.body.content.includes('Adding agenda notes'));
    assert.ok(patchBody.body.content.includes('Original reply content'));
  });

  it('throws NOT_FOUND when invite message cannot be found', async () => {
    graphGetHandler = (endpoint: string) => {
      if (endpoint.includes('/me/events/evt-12')) {
        return {
          id: 'evt-12',
          subject: 'Ghost Meeting',
          organizer: { emailAddress: { address: 'ghost@example.com' } },
        };
      }
      // Search returns empty
      if (endpoint.includes('/me/messages')) {
        return { value: [] };
      }
      return {};
    };

    await assert.rejects(() => callRespond({ event_id: 'evt-12', action: 'reply_all_draft' }), /NOT_FOUND/);
  });
});

// ── Tests — auth ────────────────────────────────────────────────────────────

describe('respond_to_meeting — auth', () => {
  beforeEach(() => resetTracking());

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(() => callRespond({ event_id: 'evt-1', action: 'accept', confirm: true }), /AUTH_REQUIRED/);
  });
});
