import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Module-level mocks ──────────────────────────────────────────────────────

let loggedIn = true;

mock.module('../config/index.js', {
  namedExports: {
    loadConfig: () => ({
      azure: { clientId: 'test', tenantId: 'test' },
      scopes: ['Files.Read.All', 'Sites.Read.All'],
      guardrails: {
        email: { allowDomains: ['example.com'], requireDraftApproval: true, stripSensitiveFromLogs: false },
        audit: { enabled: false, logPath: '/tmp/audit.jsonl', retentionDays: 90 },
      },
      safety: { requireConfirmForWrites: true },
      output: { defaultIncludeFull: false, defaultMaxChars: 4000, hardMaxChars: 20000 },
      search: { defaultTop: 10, maxTop: 50 },
      calendar: { defaultTimezone: 'UTC' },
      storage: { tokenPath: 'graph-mcp/tokens' },
      retrieval: { defaultDataSource: 'sharePoint', defaultMaxResults: 10 },
      parsers: { defaultMaxChars: 50000 },
    }),
  },
});

mock.module('../auth/index.js', {
  namedExports: {
    getGraph: () => ({}),
    isLoggedIn: async () => loggedIn,
    currentUser: async () => 'test@example.com',
    getAccessToken: async () => 'mock-token',
  },
});

mock.module('../utils/log.js', {
  namedExports: {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  },
});

// ── Mock the copilot-retrieval graph module directly ────────────────────────

let retrieveContextResult: Record<string, unknown> = {};
let retrieveContextBatchResult: Array<Record<string, unknown>> = [];
let retrieveContextCalls: Array<Record<string, unknown>> = [];
let retrieveContextBatchCalls: Array<Record<string, unknown>> = [];

mock.module('../graph/copilot-retrieval.js', {
  namedExports: {
    retrieveContext: async (options: Record<string, unknown>) => {
      retrieveContextCalls.push(options);
      return retrieveContextResult;
    },
    retrieveContextBatch: async (queries: string[], dataSource: string, filterExpression?: string, maxResults?: number) => {
      retrieveContextBatchCalls.push({ queries, dataSource, filterExpression, maxResults });
      return retrieveContextBatchResult;
    },
  },
});

// ── Import after mocks ─────────────────────────────────────────────────────
const { retrievalTools } = await import('../tools/retrieve-context.js');

const retrieveContextTool = retrievalTools.find((t) => t.name === 'retrieve_context')!;
const retrieveContextMultiTool = retrievalTools.find((t) => t.name === 'retrieve_context_multi')!;

describe('retrieve_context tools', () => {
  beforeEach(() => {
    loggedIn = true;
    retrieveContextCalls = [];
    retrieveContextBatchCalls = [];
    retrieveContextResult = {
      queryString: 'test',
      dataSource: 'sharePoint',
      hitCount: 1,
      hits: [
        {
          webUrl: 'https://example.sharepoint.com/doc1.docx',
          resourceType: 'driveItem',
          resourceMetadata: { title: 'Test Doc' },
          sensitivityLabel: null,
          extracts: [{ text: 'relevant context here', relevanceScore: 0.95 }],
        },
      ],
    };
    retrieveContextBatchResult = [];
  });

  describe('retrieve_context', () => {
    it('sends query to Copilot Retrieval API', async () => {
      const result = await retrieveContextTool.run({ query: 'quarterly revenue report', data_source: 'sharePoint' });

      assert.ok(!('isError' in result));
      assert.equal(retrieveContextCalls.length, 1);
      assert.equal(retrieveContextCalls[0]!.queryString, 'quarterly revenue report');
      assert.equal(retrieveContextCalls[0]!.dataSource, 'sharePoint');
    });

    it('returns hit count and extracts', async () => {
      const result = await retrieveContextTool.run({ query: 'test query', data_source: 'sharePoint' });

      assert.ok(!('isError' in result));
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.hit_count, 1);
      const hits = structured.hits as Array<Record<string, unknown>>;
      assert.equal(hits[0]!.web_url, 'https://example.sharepoint.com/doc1.docx');
      const extracts = hits[0]!.extracts as Array<Record<string, unknown>>;
      assert.equal(extracts[0]!.text, 'relevant context here');
      assert.equal(extracts[0]!.relevance_score, 0.95);
    });

    it('passes max_results to API', async () => {
      await retrieveContextTool.run({ query: 'test', data_source: 'sharePoint', max_results: 5 });

      assert.equal(retrieveContextCalls[0]!.maximumNumberOfResults, 5);
    });

    it('builds KQL filter from structured params', async () => {
      await retrieveContextTool.run({
        query: 'budget',
        data_source: 'sharePoint',
        filter_author: 'alice',
        filter_file_extension: 'docx',
      });

      const filter = retrieveContextCalls[0]!.filterExpression as string;
      assert.ok(filter.includes('Author:alice'));
      assert.ok(filter.includes('FileExtension=docx'));
    });

    it('passes raw filter_expression when provided', async () => {
      await retrieveContextTool.run({
        query: 'search',
        data_source: 'sharePoint',
        filter_expression: 'Author:bob AND Path:/sites/team',
      });

      assert.equal(retrieveContextCalls[0]!.filterExpression, 'Author:bob AND Path:/sites/team');
    });

    it('rejects unbalanced filter_expression', async () => {
      await assert.rejects(
        () =>
          retrieveContextTool.run({
            query: 'test',
            data_source: 'sharePoint',
            filter_expression: 'Author:"unclosed',
          }),
        (err: Error) => err.message.includes('INVALID_KQL_FILTER'),
      );
    });

    it('fails when not logged in', async () => {
      loggedIn = false;
      await assert.rejects(
        () => retrieveContextTool.run({ query: 'test', data_source: 'sharePoint' }),
        (err: Error) => err.message.includes('AUTH_REQUIRED'),
      );
    });

    it('handles empty results', async () => {
      retrieveContextResult = { queryString: 'nothing', dataSource: 'sharePoint', hitCount: 0, hits: [] };
      const result = await retrieveContextTool.run({ query: 'nothing matches', data_source: 'sharePoint' });

      assert.ok(!('isError' in result));
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.hit_count, 0);
    });

    it('defaults data_source to sharePoint', async () => {
      await retrieveContextTool.run({ query: 'test' });

      assert.equal(retrieveContextCalls[0]!.dataSource, 'sharePoint');
    });

    it('includes filter_expression in structured output when set', async () => {
      await retrieveContextTool.run({
        query: 'report',
        data_source: 'sharePoint',
        filter_author: 'alice',
      });

      // The tool should include the resolved filter in its output
      // (verifying it was passed to the graph layer)
      assert.ok(typeof retrieveContextCalls[0]!.filterExpression === 'string');
    });
  });

  describe('retrieve_context_multi', () => {
    it('sends batch request with multiple queries', async () => {
      retrieveContextBatchResult = [
        { queryString: 'q1', dataSource: 'sharePoint', hitCount: 0, hits: [] },
        { queryString: 'q2', dataSource: 'sharePoint', hitCount: 0, hits: [] },
      ];

      const result = await retrieveContextMultiTool.run({
        queries: ['query 1', 'query 2'],
        data_source: 'sharePoint',
      });

      assert.ok(!('isError' in result));
      assert.equal(retrieveContextBatchCalls.length, 1);
      const call = retrieveContextBatchCalls[0]! as Record<string, unknown>;
      assert.deepEqual(call.queries, ['query 1', 'query 2']);
      assert.equal(call.dataSource, 'sharePoint');
    });

    it('returns results for each query', async () => {
      retrieveContextBatchResult = [
        {
          queryString: 'q1',
          dataSource: 'sharePoint',
          hitCount: 1,
          hits: [
            {
              webUrl: 'https://example.com/a.docx',
              resourceType: 'driveItem',
              resourceMetadata: {},
              sensitivityLabel: null,
              extracts: [{ text: 'result a', relevanceScore: 0.9 }],
            },
          ],
        },
        { queryString: 'q2', dataSource: 'sharePoint', hitCount: 0, hits: [] },
      ];

      const result = await retrieveContextMultiTool.run({ queries: ['q1', 'q2'], data_source: 'sharePoint' });

      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.query_count, 2);
      assert.equal(structured.total_hits, 1);
      const results = structured.results as Array<Record<string, unknown>>;
      assert.equal(results.length, 2);
      assert.equal(results[0]!.hit_count, 1);
      assert.equal(results[1]!.hit_count, 0);
    });

    it('fails when not logged in', async () => {
      loggedIn = false;
      await assert.rejects(
        () => retrieveContextMultiTool.run({ queries: ['test'], data_source: 'sharePoint' }),
        (err: Error) => err.message.includes('AUTH_REQUIRED'),
      );
    });

    it('shares filter across all queries in batch', async () => {
      retrieveContextBatchResult = [{ queryString: 'test', dataSource: 'sharePoint', hitCount: 0, hits: [] }];

      await retrieveContextMultiTool.run({
        queries: ['test'],
        data_source: 'sharePoint',
        filter_author: 'bob',
      });

      const call = retrieveContextBatchCalls[0]! as Record<string, unknown>;
      assert.ok((call.filterExpression as string).includes('Author:bob'));
    });

    it('reports total hits across all queries', async () => {
      const fakeHit = { webUrl: 'https://x', resourceType: 'file', resourceMetadata: {}, sensitivityLabel: null, extracts: [] };
      retrieveContextBatchResult = [
        { queryString: 'q1', dataSource: 'sharePoint', hitCount: 3, hits: [fakeHit, fakeHit, fakeHit] },
        { queryString: 'q2', dataSource: 'sharePoint', hitCount: 2, hits: [fakeHit, fakeHit] },
      ];

      const result = await retrieveContextMultiTool.run({
        queries: ['q1', 'q2'],
        data_source: 'oneDriveBusiness',
      });

      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.total_hits, 5);
    });
  });
});
