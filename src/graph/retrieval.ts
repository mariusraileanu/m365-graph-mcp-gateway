import { getAccessToken } from '../auth/index.js';
import { loadConfig } from '../config/index.js';
import { stripHtml } from '../utils/helpers.js';

/* ── Actual API response shape from POST /v1.0/copilot/retrieval ── */

export interface RetrievalExtract {
  text: string;
  relevanceScore: number;
}

export interface RetrievalHit {
  webUrl: string;
  extracts: RetrievalExtract[];
  resourceType: string;
  resourceMetadata: Record<string, string>;
  sensitivityLabel?: {
    sensitivityLabelId: string;
    displayName: string;
    priority: number;
  };
}

export interface RetrievalResponse {
  retrievalHits: RetrievalHit[];
}

/* ── Normalized result for downstream tool consumption ── */

export interface RetrievalResult {
  webUrl: string;
  title: string;
  author: string;
  extracts: RetrievalExtract[];
  resourceType: string;
  sensitivityLabel?: string;
}

export interface RetrievalOptions {
  queryString: string;
  dataSource?: 'sharePoint' | 'oneDriveBusiness';
  filterExpression?: string;
  maxResults?: number;
  resourceMetadata?: string[];
}

/** Extract a human-readable filename from a SharePoint/OneDrive URL. */
function filenameFromUrl(url: string): string {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const segments = pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || '';
  } catch {
    return '';
  }
}

/** Determine the best title: prefer metadata, fall back to filename from URL. */
function resolveTitle(metadataTitle: string, webUrl: string): string {
  // Some documents (e.g. PowerPoint) report template/style names instead of the actual title
  const suspicious = !metadataTitle || /^(efficient elements|default|template|style)/i.test(metadataTitle.trim());
  if (suspicious) {
    const filename = filenameFromUrl(webUrl);
    return filename || metadataTitle || 'Untitled';
  }
  return metadataTitle;
}

/** Strip HTML tags, markdown-like formatting, and slide markers from extract text. */
function cleanExtract(text: string): string {
  return stripHtml(text)
    .replace(/<\/?(slide_\d+|u|span|br)\b[^>]*>/gi, '')
    .replace(/~~([^~]*)~~/g, '$1') // strikethrough
    .replace(/\*\*([^*]*)\*\*/g, '$1') // bold
    .replace(/\[image_[^\]]*\]/g, '') // image placeholders
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '') // markdown images
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Query the Microsoft 365 Copilot Retrieval API for AI-grounded search
 * across SharePoint and OneDrive content.
 */
export async function copilotRetrieval(options: RetrievalOptions): Promise<RetrievalResult[]> {
  const cfg = loadConfig().retrieval;
  if (!cfg.enabled) {
    throw new Error('RETRIEVAL_DISABLED: Copilot Retrieval API is disabled in config.yaml');
  }

  const token = await getAccessToken();
  const body: Record<string, unknown> = {
    queryString: options.queryString,
    dataSource: options.dataSource ?? cfg.dataSource,
    resourceMetadata: options.resourceMetadata ?? ['title', 'author'],
    maximumNumberOfResults: String(options.maxResults ?? 10),
  };
  if (options.filterExpression) {
    body.filterExpression = options.filterExpression;
  }

  const response = await fetch('https://graph.microsoft.com/v1.0/copilot/retrieval', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`RETRIEVAL_ERROR: Copilot Retrieval API returned ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as RetrievalResponse;
  const hits = Array.isArray(data.retrievalHits) ? data.retrievalHits : [];

  return hits.slice(0, options.maxResults ?? 10).map((hit) => ({
    webUrl: hit.webUrl,
    title: resolveTitle(hit.resourceMetadata?.title || '', hit.webUrl),
    author: hit.resourceMetadata?.author || '',
    extracts: (Array.isArray(hit.extracts) ? hit.extracts : []).map((e) => ({
      text: cleanExtract(e.text),
      relevanceScore: e.relevanceScore,
    })),
    resourceType: hit.resourceType || '',
    sensitivityLabel: hit.sensitivityLabel?.displayName,
  }));
}

/** Format retrieval results into readable text with citations. */
export function formatRetrievalResults(results: RetrievalResult[]): { text: string; citations: Array<Record<string, string>> } {
  if (results.length === 0) {
    return { text: 'No results found.', citations: [] };
  }

  const lines: string[] = [];
  const citations: Array<Record<string, string>> = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const title = r.title || 'Untitled';
    lines.push(`[${i + 1}] ${title}`);
    // Show extracts sorted by relevance
    for (const extract of r.extracts) {
      lines.push(`    ${extract.text}`);
    }
    if (r.webUrl) lines.push(`    Source: ${r.webUrl}`);
    lines.push('');

    citations.push({
      ...(r.title ? { title: r.title } : {}),
      ...(r.webUrl ? { url: r.webUrl } : {}),
      ...(r.author ? { author: r.author } : {}),
    });
  }

  return { text: lines.join('\n').trim(), citations };
}
