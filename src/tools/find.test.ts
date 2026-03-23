import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Module-level mocks (must be set up before importing find.ts) ─────────────

/** Tracks calls to searchFiles for assertion. */
const searchFilesCalls: Array<{ query: string; top: number; mode: string; includeFullPayload: boolean }> = [];
const searchFilesImpl = mock.fn(async (query: string, top: number, mode: string, includeFullPayload: boolean) => {
  searchFilesCalls.push({ query, top, mode, includeFullPayload });
  return [
    {
      id: 'file-1',
      name: 'test.docx',
      web_url: 'https://example.com/test.docx',
      snippet: 'file content',
    },
  ];
});

/** Tracks calls to calendarView for assertion. */
const calendarViewCalls: Array<{ startDate: string; endDate: string; top: number; timezone?: string }> = [];
const calendarViewImpl = mock.fn(async (startDate: string, endDate: string, top: number, timezone?: string) => {
  calendarViewCalls.push({ startDate, endDate, top, timezone });
  return [
    {
      id: 'event-cv-1',
      subject: 'CalendarView Event',
      start: '2026-03-23T09:00:00',
      end: '2026-03-23T10:00:00',
    },
  ];
});

/** Chainable Graph client mock for searchMail and searchEvents. */
const graphSearchCalls: Array<{ endpoint: string; body?: unknown }> = [];
const graphGetCalls: Array<{ endpoint: string }> = [];

function createChainableClient() {
  let currentEndpoint = '';
  const chainable: Record<string, unknown> = {};
  chainable.api = (endpoint: string) => {
    currentEndpoint = endpoint;
    return chainable;
  };
  chainable.header = () => chainable;
  chainable.search = () => chainable;
  chainable.select = () => chainable;
  chainable.top = () => chainable;
  chainable.get = async () => {
    graphGetCalls.push({ endpoint: currentEndpoint });
    // Return mail search results
    return {
      value: [
        {
          id: 'mail-1',
          subject: 'Test Email',
          from: { emailAddress: { name: 'Sender', address: 'sender@example.com' } },
          receivedDateTime: '2026-03-23T10:00:00Z',
          bodyPreview: 'email body preview',
        },
      ],
    };
  };
  chainable.post = async (body: unknown) => {
    graphSearchCalls.push({ endpoint: currentEndpoint, body });
    // Return search/query response shape
    return {
      value: [
        {
          hitsContainers: [
            {
              hits: [
                {
                  hitId: 'event-search-1',
                  resource: {
                    id: 'event-search-1',
                    subject: 'Search Event',
                    start: '2026-03-23T11:00:00',
                    end: '2026-03-23T12:00:00',
                    organizer: { emailAddress: { name: 'Org', address: 'org@example.com' } },
                  },
                  summary: 'event summary',
                },
              ],
            },
          ],
        },
      ],
    };
  };
  return chainable;
}

mock.module('../graph/files.js', {
  namedExports: { searchFiles: searchFilesImpl },
});

mock.module('../graph/calendar.js', {
  namedExports: {
    calendarView: calendarViewImpl,
    // Provide stubs for other exports if needed
    pickEvent: () => ({}),
    resolveTimezone: (tz: string) => tz,
  },
});

mock.module('../auth/index.js', {
  namedExports: {
    getGraph: () => createChainableClient(),
    isLoggedIn: async () => true,
    currentUser: async () => ({ displayName: 'Test', mail: 'test@example.com' }),
  },
});

// Suppress log output during tests
mock.module('../utils/log.js', {
  namedExports: {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  },
});

// Now import the tool after mocks are in place
const { findTools } = await import('./find.js');
const findTool = findTools[0]!;
const run = findTool.run;
const schema = findTool.schema;

/** Parse + run in one step. */
async function callFind(args: Record<string, unknown>) {
  const parsed = schema.parse(args);
  return run(parsed);
}

/** Reset all tracking arrays and mock call counts. */
function resetTracking() {
  searchFilesCalls.length = 0;
  calendarViewCalls.length = 0;
  graphSearchCalls.length = 0;
  graphGetCalls.length = 0;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('find tool — kql parameter', () => {
  beforeEach(() => resetTracking());

  it('kql overrides query for search calls', async () => {
    const result = await callFind({
      query: 'hello',
      kql: 'subject:budget',
      entity_types: ['files'],
      top: 5,
    });

    assert.ok(!('isError' in result), 'should not be an error');

    // searchFiles should have received the kql value, not the query value
    assert.equal(searchFilesCalls.length, 1);
    assert.equal(searchFilesCalls[0]!.query, 'subject:budget');
  });

  it('uses query when kql is absent', async () => {
    const result = await callFind({
      query: 'hello',
      entity_types: ['files'],
      top: 5,
    });

    assert.ok(!('isError' in result), 'should not be an error');
    assert.equal(searchFilesCalls.length, 1);
    assert.equal(searchFilesCalls[0]!.query, 'hello');
  });

  it('includes kql in response only when provided', async () => {
    // With kql
    const withKql = await callFind({
      query: 'test',
      kql: 'from:alice@example.com',
      entity_types: ['mail'],
    });
    const sc1 = withKql.structuredContent as Record<string, unknown>;
    assert.equal(sc1.kql, 'from:alice@example.com', 'kql should be in response');

    // Without kql
    const withoutKql = await callFind({
      query: 'test',
      entity_types: ['mail'],
    });
    const sc2 = withoutKql.structuredContent as Record<string, unknown>;
    assert.ok(!('kql' in sc2), 'kql should NOT be in response when not provided');
  });
});

describe('find tool — entity type filtering', () => {
  beforeEach(() => resetTracking());

  it('mail-only does not call searchFiles or calendarView', async () => {
    await callFind({ query: 'test', entity_types: ['mail'], top: 3 });

    assert.equal(searchFilesCalls.length, 0, 'searchFiles should not be called');
    assert.equal(calendarViewCalls.length, 0, 'calendarView should not be called');
    // graphSearchCalls should be empty too (searchEvents uses /search/query, mail uses /me/messages via get)
    assert.equal(graphSearchCalls.length, 0, 'no /search/query calls for mail-only');
    assert.equal(graphGetCalls.length, 1, 'one /me/messages get call');
  });

  it('files-only does not call mail or event search', async () => {
    await callFind({ query: 'test', entity_types: ['files'], top: 3 });

    assert.equal(searchFilesCalls.length, 1, 'searchFiles should be called');
    assert.equal(graphGetCalls.length, 0, 'no /me/messages call');
    assert.equal(calendarViewCalls.length, 0, 'no calendarView call');
    assert.equal(graphSearchCalls.length, 0, 'no /search/query call');
  });
});

describe('find tool — event search routing', () => {
  beforeEach(() => resetTracking());

  it('date-range triggers calendarView, not text-search', async () => {
    const result = await callFind({
      query: 'meetings',
      entity_types: ['events'],
      start_date: '2026-03-23T00:00:00',
      end_date: '2026-03-24T00:00:00',
      top: 5,
    });

    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(calendarViewCalls.length, 1, 'calendarView should be called');
    assert.equal(graphSearchCalls.length, 0, 'no /search/query call');
    assert.ok((sc.providers as string[]).includes('calendar-view'), 'provider should be calendar-view');
  });

  it('no dates triggers text-search events, not calendarView', async () => {
    const result = await callFind({
      query: 'meetings',
      entity_types: ['events'],
      top: 5,
    });

    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(calendarViewCalls.length, 0, 'calendarView should not be called');
    assert.equal(graphSearchCalls.length, 1, 'one /search/query call for events');
    assert.ok((sc.providers as string[]).includes('graph-search'), 'provider should be graph-search');
  });
});

describe('find tool — error resilience', () => {
  beforeEach(() => resetTracking());

  it('partial failure: searchFiles throws, mail still returns', async () => {
    // Temporarily make searchFiles throw
    searchFilesImpl.mock.mockImplementationOnce(async () => {
      throw new Error('Graph API timeout');
    });

    const result = await callFind({
      query: 'test',
      entity_types: ['mail', 'files'],
      top: 3,
    });

    // Should not be a top-level error — allSettled means partial success
    assert.ok(!('isError' in result), 'should not be a top-level error');

    const sc = result.structuredContent as Record<string, unknown>;

    // Mail results should still be present
    assert.ok((sc.result_count as number) >= 1, 'should have at least mail results');

    // Errors array should contain the file search failure
    const errors = sc.errors as string[] | undefined;
    assert.ok(Array.isArray(errors), 'errors array should be present');
    assert.ok(
      errors.some((e) => e.includes('Graph API timeout')),
      'should include file search error',
    );
  });
});
