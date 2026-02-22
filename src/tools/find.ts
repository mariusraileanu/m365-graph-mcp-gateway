import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { ok, compactText, normalizeTop } from '../utils/helpers.js';
import { getGraph } from '../auth/index.js';
import { copilotRetrieval } from '../graph/retrieval.js';
import { searchFiles } from '../graph/files.js';
import { calendarView } from '../graph/calendar.js';
import { log } from '../utils/log.js';
import type { ToolSpec } from '../utils/types.js';

type EntityType = 'mail' | 'files' | 'events';

/** Search mail via Graph /search/query */
async function searchMail(query: string, top: number): Promise<Record<string, unknown>[]> {
  const messages = await getGraph()
    .api('/me/messages')
    .header('ConsistencyLevel', 'eventual')
    .search(`"${query.replace(/"/g, '')}"`)
    .select('id,subject,from,receivedDateTime,bodyPreview')
    .top(top)
    .get();
  return ((messages as { value?: Array<Record<string, unknown>> }).value ?? []).map((m) => ({
    type: 'mail',
    id: m.id,
    subject: m.subject,
    from: m.from,
    received_at: m.receivedDateTime,
    snippet: typeof m.bodyPreview === 'string' ? m.bodyPreview.slice(0, 200) : undefined,
  }));
}

/** Search events via Graph /search/query (text-based, no date filtering) */
async function searchEvents(query: string, top: number): Promise<Record<string, unknown>[]> {
  const response = await getGraph()
    .api('/search/query')
    .post({
      requests: [{ entityTypes: ['event'], query: { queryString: query }, from: 0, size: top }],
    });
  const values = (response as { value?: unknown[] }).value ?? [];
  const hits =
    (
      values[0] as
        | { hitsContainers?: Array<{ hits?: Array<{ hitId?: string; resource?: Record<string, unknown>; summary?: string }> }> }
        | undefined
    )?.hitsContainers?.[0]?.hits ?? [];
  return hits.map((h) => {
    const r = h.resource ?? {};
    return {
      type: 'event',
      id: h.hitId || r.id,
      subject: r.subject,
      start: r.start,
      end: r.end,
      organizer: r.organizer,
      snippet: h.summary,
    };
  });
}

/** Fetch events in a date range via CalendarView API (expands recurring events, includes attendees). */
async function listEvents(startDate: string, endDate: string, top: number, timezone?: string): Promise<Record<string, unknown>[]> {
  const events = await calendarView(startDate, endDate, top, timezone);
  return events.map((e) => ({ type: 'event', ...e }));
}

/** Search files via Copilot Retrieval API (preferred) with Graph Search fallback */
async function searchFilesHybrid(query: string, top: number): Promise<{ results: Record<string, unknown>[]; provider: string }> {
  try {
    const retrievalResults = await copilotRetrieval({ queryString: query, dataSource: 'sharePoint', maxResults: top });
    if (retrievalResults.length > 0) {
      return {
        provider: 'copilot-retrieval',
        results: retrievalResults.map((r) => ({
          type: 'file',
          title: r.title,
          source_url: r.webUrl,
          author: r.author,
          resource_type: r.resourceType,
          snippet: r.extracts.map((e) => e.text).join(' '),
          sensitivity_label: r.sensitivityLabel,
        })),
      };
    }
  } catch (err) {
    log.warn('Copilot Retrieval API failed, falling back to Graph Search', { error: (err as Error).message });
  }
  // Fallback to Graph Search API
  const files = await searchFiles(query, top, 'both', false);
  return { provider: 'graph-search', results: files.map((f) => ({ type: 'file', ...f })) };
}

export const findTools: ToolSpec[] = [
  {
    name: 'find',
    description:
      'Search across Microsoft 365 — mail, files, and calendar events. ' +
      'For calendar events: provide start_date and end_date (ISO 8601) to list all events in a date range ' +
      '(includes organizer, attendees, location). Resolve relative dates like "Monday" or "next week" to concrete ISO dates before calling. ' +
      'Without date params, falls back to text-based search. ' +
      'Uses Copilot Retrieval API for files and Graph Search for mail.',
    schema: z
      .object({
        query: z.string().min(1),
        entity_types: z.array(z.enum(['mail', 'files', 'events'])).optional(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        top: z.number().int().positive().max(50).optional(),
        max_chars: z.number().int().positive().max(50000).optional(),
      })
      .strict(),
    run: async (params) => {
      const query = String(params.query).trim();
      const entityTypes: EntityType[] = Array.isArray(params.entity_types)
        ? (params.entity_types.map(String) as EntityType[])
        : ['mail', 'files', 'events'];
      const startDate = typeof params.start_date === 'string' ? params.start_date.trim() : '';
      const endDate = typeof params.end_date === 'string' ? params.end_date.trim() : '';
      const top = normalizeTop(params.top);
      const maxChars = Number.parseInt(String(params.max_chars || loadConfig().output.defaultMaxChars), 10);

      const t0 = Date.now();

      // Run searches in parallel for requested entity types
      const searches: Promise<{ type: string; provider: string; results: Record<string, unknown>[] }>[] = [];

      if (entityTypes.includes('files')) {
        searches.push(searchFilesHybrid(query, top).then((r) => ({ type: 'files', ...r })));
      }
      if (entityTypes.includes('mail')) {
        searches.push(searchMail(query, top).then((results) => ({ type: 'mail', provider: 'graph-search', results })));
      }
      if (entityTypes.includes('events')) {
        if (startDate && endDate) {
          // Date range provided: use CalendarView API for precise results with full attendee data
          searches.push(listEvents(startDate, endDate, top).then((results) => ({ type: 'events', provider: 'calendar-view', results })));
        } else {
          // No date range: fall back to text-based search
          searches.push(searchEvents(query, top).then((results) => ({ type: 'events', provider: 'graph-search', results })));
        }
      }

      const searchResults = await Promise.allSettled(searches);
      const allResults: Record<string, unknown>[] = [];
      const providers: string[] = [];
      const errors: string[] = [];

      for (const result of searchResults) {
        if (result.status === 'fulfilled') {
          allResults.push(...result.value.results);
          if (!providers.includes(result.value.provider)) providers.push(result.value.provider);
        } else {
          errors.push(result.reason?.message || String(result.reason));
        }
      }

      const summaryText =
        allResults.length > 0
          ? allResults
              .slice(0, top)
              .map((r, i) => {
                const title = r.subject || r.title || r.name || 'Untitled';
                const url = r.source_url || r.web_url || r.web_link || '';
                const link = url ? `\n   Link: ${String(url)}` : '';
                const snippet = r.snippet ? `\n   ${String(r.snippet).slice(0, 200)}` : '';
                return `[${i + 1}] ${String(title)}${link}${snippet}`;
              })
              .join('\n')
          : 'No results found.';

      const compact = compactText(summaryText, maxChars);

      const hasEvents = entityTypes.includes('events');

      return ok(compact.text, {
        providers,
        query,
        entity_types: entityTypes,
        ...(startDate ? { start_date: startDate } : {}),
        ...(endDate ? { end_date: endDate } : {}),
        ...(hasEvents ? { timezone: loadConfig().calendar.defaultTimezone } : {}),
        top,
        elapsed_ms: Date.now() - t0,
        result_count: allResults.length,
        summary: compact.text,
        truncated: compact.truncated,
        results: allResults.slice(0, top),
        ...(errors.length > 0 ? { errors } : {}),
      });
    },
  },
];
