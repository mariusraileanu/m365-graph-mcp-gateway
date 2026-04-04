/**
 * MCP tools for Microsoft 365 Copilot Retrieval API.
 *
 * retrieve_context      — single semantic query against M365 content
 * retrieve_context_multi — batched multi-query via Graph $batch (up to 20)
 *
 * Both tools expose structured KQL filter building via optional parameters,
 * or accept a raw filter_expression for advanced users.
 */

import { z } from 'zod';
import { isLoggedIn } from '../auth/index.js';
import { ok } from '../utils/helpers.js';
import { loadConfig } from '../config/index.js';
import { retrieveContext, retrieveContextBatch } from '../graph/copilot-retrieval.js';
import { buildKqlFilter, supportedKqlFields, isValidKqlExpression } from '../utils/kql.js';
import type { RetrievalDataSource, RetrievalResult } from '../graph/copilot-retrieval.js';
import type { ToolSpec } from '../utils/types.js';

/** Max query length enforced by the Retrieval API. */
const MAX_QUERY_CHARS = 1500;

/** Flatten a RetrievalResult into a clean JSON shape for tool output. */
function formatResult(r: RetrievalResult): Record<string, unknown> {
  return {
    query: r.queryString,
    data_source: r.dataSource,
    hit_count: r.hitCount,
    hits: r.hits.map((h) => ({
      web_url: h.webUrl ?? '',
      resource_type: h.resourceType ?? '',
      sensitivity_label: h.sensitivityLabel ?? null,
      extracts: (h.extracts ?? []).map((e) => ({
        text: e.text,
        relevance_score: e.relevanceScore,
      })),
      resource_metadata: h.resourceMetadata ?? {},
    })),
  };
}

/** Build filter expression from structured params or raw expression. */
function resolveFilter(params: Record<string, unknown>): string | undefined {
  // Raw expression takes precedence
  if (typeof params.filter_expression === 'string' && params.filter_expression.trim()) {
    const raw = params.filter_expression.trim();
    if (!isValidKqlExpression(raw)) {
      throw new Error(
        'INVALID_KQL_FILTER: filter_expression has unbalanced quotes or parentheses. ' +
          'Note: if filter is invalid, the Retrieval API silently ignores it.',
      );
    }
    return raw;
  }

  // Build from structured filter params
  const clauses: Array<{ field: string; operator?: ':' | '=' | '>' | '<' | '>=' | '<='; value: string }> = [];

  if (typeof params.filter_author === 'string' && params.filter_author.trim()) {
    clauses.push({ field: 'Author', value: params.filter_author.trim() });
  }
  if (typeof params.filter_file_extension === 'string' && params.filter_file_extension.trim()) {
    clauses.push({ field: 'FileExtension', operator: '=', value: params.filter_file_extension.trim() });
  }
  if (typeof params.filter_filename === 'string' && params.filter_filename.trim()) {
    clauses.push({ field: 'Filename', value: params.filter_filename.trim() });
  }
  if (typeof params.filter_path === 'string' && params.filter_path.trim()) {
    clauses.push({ field: 'Path', value: params.filter_path.trim() });
  }
  if (typeof params.filter_site_id === 'string' && params.filter_site_id.trim()) {
    clauses.push({ field: 'SiteID', operator: '=', value: params.filter_site_id.trim() });
  }
  if (typeof params.filter_title === 'string' && params.filter_title.trim()) {
    clauses.push({ field: 'Title', value: params.filter_title.trim() });
  }
  if (typeof params.filter_modified_after === 'string' && params.filter_modified_after.trim()) {
    clauses.push({ field: 'LastModifiedTime', operator: '>', value: params.filter_modified_after.trim() });
  }

  if (clauses.length === 0) return undefined;

  return buildKqlFilter({
    clauses,
    join: (params.filter_join as 'AND' | 'OR') ?? 'AND',
  });
}

/** Shared filter-related schema fields (used by both tools). */
const filterSchemaFields = {
  filter_expression: z.string().max(500).optional().describe('Raw KQL filter expression. Overrides structured filter_* params if set.'),
  filter_author: z.string().optional().describe('Filter by author name (KQL Author field).'),
  filter_file_extension: z.string().optional().describe('Filter by file extension, e.g. "docx", "pdf".'),
  filter_filename: z.string().optional().describe('Filter by filename (partial match).'),
  filter_path: z.string().optional().describe('Filter by SharePoint/OneDrive path.'),
  filter_site_id: z.string().optional().describe('Filter by SharePoint Site ID.'),
  filter_title: z.string().optional().describe('Filter by document title.'),
  filter_modified_after: z.string().optional().describe('Filter to files modified after this ISO date.'),
  filter_join: z.enum(['AND', 'OR']).default('AND').optional().describe('Join structured filters with AND (default) or OR.'),
};

export const retrievalTools: ToolSpec[] = [
  {
    name: 'retrieve_context',
    description:
      'Semantic search across Microsoft 365 content using the Copilot Retrieval API. ' +
      'Returns relevant extracts with relevance scores from SharePoint, OneDrive for Business, or external items. ' +
      'Query must be a natural language sentence (max 1500 chars). ' +
      'Use structured filter_* params or raw filter_expression (KQL syntax) to scope results. ' +
      `Supported KQL fields: ${supportedKqlFields().join(', ')}. ` +
      'Rate limit: 200 requests/user/hour.',
    schema: z
      .object({
        query: z.string().min(1).max(MAX_QUERY_CHARS).describe('Natural language query (max 1500 chars, single sentence).'),
        data_source: z
          .enum(['sharePoint', 'oneDriveBusiness', 'externalItem'])
          .default('sharePoint')
          .describe('Content source to search. One per request.'),
        max_results: z.number().int().min(1).max(25).default(10).optional().describe('Max results to return (1-25, default 10).'),
        ...filterSchemaFields,
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');

      const query = String(params.query).trim();
      const dataSource = (params.data_source ?? 'sharePoint') as RetrievalDataSource;
      const maxResults = typeof params.max_results === 'number' ? params.max_results : (loadConfig().search.defaultTop ?? 10);

      const filterExpression = resolveFilter(params);

      const result = await retrieveContext({
        queryString: query,
        dataSource,
        filterExpression,
        maximumNumberOfResults: maxResults,
      });

      const formatted = formatResult(result);

      const summary =
        result.hitCount > 0
          ? `Found ${result.hitCount} result(s) from ${dataSource}.`
          : `No results found in ${dataSource} for: "${query}"`;

      return ok(summary, {
        ...formatted,
        ...(filterExpression ? { filter_expression: filterExpression } : {}),
        max_results: maxResults,
      });
    },
  },
  {
    name: 'retrieve_context_multi',
    description:
      'Batched semantic search — send up to 20 queries in a single Graph $batch call. ' +
      'All queries share the same data_source and optional filter. ' +
      'Returns an array of results, one per query. ' +
      'Rate limit: each query in the batch counts toward the 200 requests/user/hour limit.',
    schema: z
      .object({
        queries: z
          .array(z.string().min(1).max(MAX_QUERY_CHARS))
          .min(1)
          .max(20)
          .describe('Array of natural language queries (1-20, each max 1500 chars).'),
        data_source: z
          .enum(['sharePoint', 'oneDriveBusiness', 'externalItem'])
          .default('sharePoint')
          .describe('Content source to search. Shared across all queries.'),
        max_results: z.number().int().min(1).max(25).default(10).optional().describe('Max results per query (1-25, default 10).'),
        ...filterSchemaFields,
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');

      const queries = (params.queries as string[]).map((q) => String(q).trim());
      const dataSource = (params.data_source ?? 'sharePoint') as RetrievalDataSource;
      const maxResults = typeof params.max_results === 'number' ? params.max_results : (loadConfig().search.defaultTop ?? 10);

      const filterExpression = resolveFilter(params);

      const results = await retrieveContextBatch(queries, dataSource, filterExpression, maxResults);

      const formatted = results.map(formatResult);
      const totalHits = results.reduce((sum, r) => sum + r.hitCount, 0);

      return ok(`Batch: ${queries.length} queries, ${totalHits} total hits from ${dataSource}.`, {
        query_count: queries.length,
        total_hits: totalHits,
        data_source: dataSource,
        ...(filterExpression ? { filter_expression: filterExpression } : {}),
        max_results: maxResults,
        results: formatted,
      });
    },
  },
];
