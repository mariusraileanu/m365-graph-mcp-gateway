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
  chainable.search = () => chainable;
  chainable.query = () => chainable;
  chainable.get = async () => ({});
  chainable.post = async (body: unknown) => {
    graphPostCalls.push({ endpoint: currentEndpoint, body });
    return graphPostResponse;
  };
  chainable.patch = async () => ({});
  return chainable;
}

// Config mock — must be before any module that calls loadConfig() at import time
let allowDomains = ['example.com', 'b.com'];
mock.module('../config/index.js', {
  namedExports: {
    loadConfig: () => ({
      azure: { clientId: 'test', tenantId: 'test' },
      scopes: ['Mail.ReadWrite'],
      guardrails: {
        email: { allowDomains, requireDraftApproval: true, stripSensitiveFromLogs: false },
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

// Audit mock — no-op logger (constructor would call loadConfig, so we mock the whole module)
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

// Mail helpers mock
const createReplyDraftCalls: Array<{ messageId: string; bodyHtml: string; replyAll: boolean }> = [];
mock.module('../graph/mail.js', {
  namedExports: {
    pickMail: (msg: Record<string, unknown>) => msg,
    buildMailAttachments: async () => ({ attachments: [], count: 0, totalBytes: 0 }),
    createReplyDraft: async (messageId: string, bodyHtml: string, replyAll: boolean) => {
      createReplyDraftCalls.push({ messageId, bodyHtml, replyAll });
      return { id: 'draft-reply-1', source_message_id: messageId, is_draft: true as const };
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

mock.module('../utils/log.js', {
  namedExports: {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  },
});

// ── Import tool AFTER mocks ─────────────────────────────────────────────────

const { composeEmailTools } = await import('./compose-email.js');
const tool = composeEmailTools[0]!;

async function callCompose(args: Record<string, unknown>) {
  return tool.run(tool.schema.parse(args));
}

function resetTracking() {
  graphPostCalls.length = 0;
  auditLogCalls.length = 0;
  createReplyDraftCalls.length = 0;
  graphPostResponse = {};
  loggedIn = true;
  allowDomains = ['example.com', 'b.com'];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('compose_email — draft mode', () => {
  beforeEach(() => resetTracking());

  it('creates a draft email', async () => {
    graphPostResponse = { id: 'draft-001' };
    const result = await callCompose({
      mode: 'draft',
      to: 'alice@example.com',
      subject: 'Test Draft',
      body_html: '<p>Hello</p>',
    });

    assert.ok(!('isError' in result));
    assert.equal(graphPostCalls.length, 1);
    assert.ok(graphPostCalls[0]!.endpoint.includes('/me/messages'));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.id, 'draft-001');
    assert.equal(sc.is_draft, true);
  });

  it('throws VALIDATION_ERROR when to is missing', async () => {
    await assert.rejects(() => callCompose({ mode: 'draft', subject: 'No To', body_html: '<p>x</p>' }), /VALIDATION_ERROR.*to is required/);
  });

  it('throws VALIDATION_ERROR when subject is missing', async () => {
    await assert.rejects(
      () => callCompose({ mode: 'draft', to: 'a@b.com', body_html: '<p>x</p>' }),
      /VALIDATION_ERROR.*subject is required/,
    );
  });
});

describe('compose_email — send mode', () => {
  beforeEach(() => resetTracking());

  it('returns preview when confirm is missing', async () => {
    const result = await callCompose({
      mode: 'send',
      to: 'alice@example.com',
      subject: 'Test Send',
      body_html: '<p>Hello</p>',
    });

    assert.ok(!('isError' in result));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.requires_confirmation, true);
    assert.equal(sc.action, 'compose_email (send)');
    assert.equal(graphPostCalls.length, 0, 'should NOT call Graph API');
  });

  it('sends email when confirm=true', async () => {
    const result = await callCompose({
      mode: 'send',
      to: 'alice@example.com',
      subject: 'Test Send',
      body_html: '<p>Hello</p>',
      confirm: true,
    });

    assert.ok(!('isError' in result));
    assert.equal(graphPostCalls.length, 1);
    assert.ok(graphPostCalls[0]!.endpoint.includes('/me/sendMail'));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.success, true);
    // Verify audit was logged
    assert.equal(auditLogCalls.length, 1);
    assert.equal(auditLogCalls[0]!.action, 'compose_email_send');
  });

  it('throws FORBIDDEN when domain is not in allowlist', async () => {
    allowDomains = ['example.com'];
    await assert.rejects(
      () =>
        callCompose({
          mode: 'send',
          to: 'alice@blocked.org',
          subject: 'Blocked',
          body_html: '<p>x</p>',
          confirm: true,
        }),
      /FORBIDDEN.*not in allowlist/,
    );
  });
});

describe('compose_email — reply mode', () => {
  beforeEach(() => resetTracking());

  it('creates reply draft when confirm is missing', async () => {
    const result = await callCompose({
      mode: 'reply',
      message_id: 'orig-msg-1',
      body_html: '<p>Thanks</p>',
    });

    assert.ok(!('isError' in result));
    assert.equal(createReplyDraftCalls.length, 1);
    assert.equal(createReplyDraftCalls[0]!.messageId, 'orig-msg-1');
    assert.equal(createReplyDraftCalls[0]!.replyAll, false);
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.mode, 'draft');
    assert.equal(sc.is_draft, true);
  });

  it('sends reply immediately when confirm=true', async () => {
    const result = await callCompose({
      mode: 'reply',
      message_id: 'orig-msg-2',
      body_html: '<p>Noted</p>',
      confirm: true,
    });

    assert.ok(!('isError' in result));
    assert.equal(graphPostCalls.length, 1);
    assert.ok(graphPostCalls[0]!.endpoint.includes('/me/messages/orig-msg-2/reply'));
    assert.ok(!graphPostCalls[0]!.endpoint.includes('replyAll'));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.mode, 'send');
  });

  it('throws VALIDATION_ERROR when message_id is missing', async () => {
    await assert.rejects(() => callCompose({ mode: 'reply', body_html: '<p>x</p>' }), /VALIDATION_ERROR.*message_id/);
  });
});

describe('compose_email — reply_all mode', () => {
  beforeEach(() => resetTracking());

  it('sends reply-all when confirm=true', async () => {
    const result = await callCompose({
      mode: 'reply_all',
      message_id: 'orig-msg-3',
      body_html: '<p>Everyone</p>',
      confirm: true,
    });

    assert.ok(!('isError' in result));
    assert.equal(graphPostCalls.length, 1);
    assert.ok(graphPostCalls[0]!.endpoint.includes('/me/messages/orig-msg-3/replyAll'));
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.mode, 'send');
  });
});

describe('compose_email — auth', () => {
  beforeEach(() => resetTracking());

  it('throws AUTH_REQUIRED when not logged in', async () => {
    loggedIn = false;
    await assert.rejects(() => callCompose({ mode: 'draft', to: 'a@b.com', subject: 'x', body_html: '<p>x</p>' }), /AUTH_REQUIRED/);
  });
});
