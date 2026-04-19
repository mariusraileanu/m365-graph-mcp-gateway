/**
 * Copilot Retrieval API — semantic grounding from Microsoft 365 content.
 *
 * Endpoint: POST /v1.0/copilot/retrieval
 * Auth: delegated only (Files.Read.All + Sites.Read.All)
 * Rate limit: 200 requests per user per hour
 *
 * The $batch endpoint supports up to 20 requests per call.
 */

import { graphFetch } from './http.js';
import { log } from '../utils/log.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const RETRIEVAL_PATH = '/copilot/retrieval';
const BATCH_PATH = '/$batch';
const MAX_BATCH_SIZE = 20;
const MAX_QUERY_CHARS = 1500;
const MAX_RESULTS_LIMIT = 25;

export type RetrievalDataSource = 'sharePoint' | 'oneDriveBusiness' | 'externalItem';

export interface RetrievalHitExtract {
  text: string;
  relevanceScore: number;
}

export interface RetrievalHit {
  webUrl: string;
  resourceType: string;
  resourceMetadata: Record<string, unknown>;
  sensitivityLabel: string | null;
  extracts: RetrievalHitExtract[];
}

export interface RetrievalResult {
  queryString: string;
  dataSource: RetrievalDataSource;
  hits: RetrievalHit[];
  hitCount: number;
  error?: {
    status?: number;
    message: string;
  };
}

interface RetrievalOptions {
  queryString: string;
  dataSource: RetrievalDataSource;
  filterExpression?: string;
  maximumNumberOfResults?: number;
}

function buildRequestBody(options: RetrievalOptions): Record<string, unknown> {
  const maxResults = Math.max(1, Math.min(options.maximumNumberOfResults ?? 25, MAX_RESULTS_LIMIT));
  const query = options.queryString.slice(0, MAX_QUERY_CHARS);

  const body: Record<string, unknown> = {
    dataSource: options.dataSource,
    queryString: query,
    maximumNumberOfResults: maxResults,
  };

  if (options.filterExpression) {
    body.filterExpression = options.filterExpression;
  }

  return body;
}

function normalizeHit(raw: Record<string, unknown>): RetrievalHit {
  const extracts = Array.isArray(raw.extracts)
    ? (raw.extracts as Array<Record<string, unknown>>).map((e) => ({
        text: String(e.text ?? ''),
        relevanceScore: Number(e.relevanceScore ?? 0),
      }))
    : [];

  return {
    webUrl: String(raw.webUrl ?? ''),
    resourceType: String(raw.resourceType ?? ''),
    resourceMetadata: (raw.resourceMetadata as Record<string, unknown>) ?? {},
    sensitivityLabel: raw.sensitivityLabel != null ? String(raw.sensitivityLabel) : null,
    extracts,
  };
}

type GraphRetrievalResponse = {
  value?: Array<Record<string, unknown>>;
};

type GraphBatchItemResponse = {
  id: string;
  status: number;
  body?: GraphRetrievalResponse & {
    error?: {
      message?: unknown;
    };
  };
};

type GraphBatchResponse = {
  responses?: GraphBatchItemResponse[];
};

/**
 * Single-query retrieval — POST /v1.0/copilot/retrieval
 */
export async function retrieveContext(options: RetrievalOptions): Promise<RetrievalResult> {
  const body = buildRequestBody(options);

  log.debug('copilot-retrieval', { queryString: options.queryString, dataSource: options.dataSource });

  const response = await graphFetch(`${GRAPH_BASE}${RETRIEVAL_PATH}`, 'UPSTREAM_ERROR: Copilot Retrieval API failed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as GraphRetrievalResponse;
  const rawHits = Array.isArray(data.value) ? data.value : [];
  const hits = rawHits.map(normalizeHit);

  return {
    queryString: options.queryString,
    dataSource: options.dataSource,
    hits,
    hitCount: hits.length,
  };
}

/**
 * Batched multi-query retrieval — POST /v1.0/$batch
 *
 * Sends up to 20 retrieval requests in a single batch call.
 * Each query in the batch shares the same dataSource and optional filter.
 */
export async function retrieveContextBatch(
  queries: string[],
  dataSource: RetrievalDataSource,
  filterExpression?: string,
  maximumNumberOfResults?: number,
): Promise<RetrievalResult[]> {
  if (queries.length === 0) return [];
  if (queries.length > MAX_BATCH_SIZE) {
    throw new Error(`VALIDATION_ERROR: batch size ${queries.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
  }

  const requests = queries.map((q, i) => {
    const body = buildRequestBody({
      queryString: q,
      dataSource,
      filterExpression,
      maximumNumberOfResults,
    });

    return {
      id: String(i),
      method: 'POST',
      url: RETRIEVAL_PATH,
      headers: { 'Content-Type': 'application/json' },
      body,
    };
  });

  log.debug('copilot-retrieval-batch', { queryCount: queries.length, dataSource });

  const response = await graphFetch(`${GRAPH_BASE}${BATCH_PATH}`, 'UPSTREAM_ERROR: Graph $batch failed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });

  const batchResponse = (await response.json()) as GraphBatchResponse;
  const responsesById = new Map((batchResponse.responses ?? []).map((item) => [item.id, item]));

  return queries.map((queryString, i) => {
    const responseId = String(i);
    const item = responsesById.get(responseId);

    if (!item) {
      log.warn('copilot-retrieval-batch-item-missing', { id: responseId, queryString });
      return {
        queryString,
        dataSource,
        hits: [],
        hitCount: 0,
        error: { message: 'Missing batch item response' },
      };
    }

    if (item.status !== 200) {
      const message =
        typeof item.body?.error?.message === 'string' && item.body.error.message.trim()
          ? item.body.error.message
          : `Copilot Retrieval batch item failed (${item.status})`;
      log.warn('copilot-retrieval-batch-item-error', { id: item.id, status: item.status, queryString, message });
      return {
        queryString,
        dataSource,
        hits: [],
        hitCount: 0,
        error: { status: item.status, message },
      };
    }

    const rawHits = Array.isArray(item.body?.value) ? item.body.value : [];
    const hits = rawHits.map(normalizeHit);
    return { queryString, dataSource, hits, hitCount: hits.length };
  });
}
