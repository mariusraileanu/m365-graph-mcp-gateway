import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { compactText, normalizeTop, graphMailboxPath, normalizeMailboxUser } from '../utils/helpers.js';
import { getGraph } from '../auth/index.js';
import { extractGraphSearchHits, searchFiles } from '../graph/files.js';
import { calendarView } from '../graph/calendar.js';
import { log } from '../utils/log.js';
import { ok } from './results.js';
import { defineTool } from './types.js';
import type { GraphCollectionResponse, GraphMailMessage, GraphSearchResponse } from '../graph/types.js';

type EntityType = 'mail' | 'files' | 'events';

type GraphEventSearchResource = {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
};

type FindResultItem = Record<string, unknown>;
type SearchExecution = { type: EntityType; provider: string; results: FindResultItem[] };

/** Search mail via Graph /me/messages or /users/{mailbox_user}/messages */
async function searchMail(query: string, top: number, mailboxUser?: string | null): Promise<FindResultItem[]> {
  const messages = await getGraph()
    .api(graphMailboxPath('/messages', mailboxUser))
    .header('ConsistencyLevel', 'eventual')
    .search(`"${query.replace(/"/g, '')}"`)
    .select('id,subject,from,receivedDateTime,bodyPreview')
    .top(top)
    .get();
  return ((messages as GraphCollectionResponse<GraphMailMessage>).value ?? []).map((message) => ({
    type: 'mail',
    id: message.id,
    subject: message.subject,
    from: message.from,
    received_at: message.receivedDateTime,
    snippet: typeof message.bodyPreview === 'string' ? message.bodyPreview.slice(0, 200) : undefined,
  }));
}

/** Search events via Graph /search/query (text-based, no date filtering) */
async function searchEvents(query: string, top: number): Promise<FindResultItem[]> {
  const response = await getGraph()
    .api('/search/query')
    .post({
      requests: [{ entityTypes: ['event'], query: { queryString: query }, from: 0, size: top }],
    });
  const hits = extractGraphSearchHits(response as GraphSearchResponse<GraphEventSearchResource>);
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

/** Fetch events in a date range via CalendarView API with a compact summary-first shape. */
async function listEvents(
  startDate: string,
  endDate: string,
  top: number,
  timezone?: string,
  mailboxUser?: string | null,
): Promise<FindResultItem[]> {
  const events = await calendarView(startDate, endDate, top, timezone, mailboxUser || undefined, 'minimal');
  return events.map((e) => ({ type: 'event', ...e }));
}

export const findTools = [
  defineTool({
    name: 'find',
    description:
      'Search across Microsoft 365 — mail, files, and calendar events. ' +
      'For calendar events: provide start_date and end_date (ISO 8601) to list all events in a date range ' +
      '(includes organizer, location, and meeting links in a compact shape). Resolve relative dates like "Monday" or "next week" to concrete ISO dates before calling. ' +
      'Optional mailbox_user targets a shared mailbox/calendar (UPN/email/object-id) via /users/{mailbox_user}. ' +
      'When mailbox_user is set for events, start_date and end_date are required. ' +
      'Without date params, falls back to text-based search. ' +
      'Uses Graph Search API. Pass kql to override query with a raw KQL expression.',
    schema: z
      .object({
        query: z.string().min(1),
        kql: z.string().optional(),
        entity_types: z.array(z.enum(['mail', 'files', 'events'])).optional(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        mailbox_user: z.string().min(1).optional(),
        top: z.number().int().positive().max(50).optional(),
        max_chars: z.number().int().positive().max(50000).optional(),
      })
      .strict(),
    run: async (params) => {
      const query = params.query.trim();
      const kql = params.kql?.trim() ?? '';
      const queryString = kql || query;

      log.debug('find', { query, kql: kql || undefined, effectiveQuery: queryString });

      const entityTypes: EntityType[] = params.entity_types ?? ['mail', 'files', 'events'];
      const startDate = params.start_date?.trim() ?? '';
      const endDate = params.end_date?.trim() ?? '';
      const mailboxUser = normalizeMailboxUser(params.mailbox_user);
      const top = normalizeTop(params.top);
      const maxChars = params.max_chars ?? loadConfig().output.defaultMaxChars;

      const t0 = Date.now();

      // Run searches in parallel for requested entity types
      const searches: Promise<SearchExecution>[] = [];
      const preValidationErrors: string[] = [];

      if (entityTypes.includes('files')) {
        searches.push(
          searchFiles(queryString, top, 'both', false).then((results) => ({
            type: 'files',
            provider: 'graph-search',
            results: results.map((f) => ({ type: 'file', item_id: f.id, ...f })),
          })),
        );
      }
      if (entityTypes.includes('mail')) {
        searches.push(searchMail(queryString, top, mailboxUser).then((results) => ({ type: 'mail', provider: 'graph-search', results })));
      }
      if (entityTypes.includes('events')) {
        if (startDate && endDate) {
          // Date range provided: use CalendarView API for precise summary-first event results
          searches.push(
            listEvents(startDate, endDate, top, undefined, mailboxUser).then((results) => ({
              type: 'events',
              provider: 'calendar-view',
              results,
            })),
          );
        } else {
          if (mailboxUser) {
            const message = 'VALIDATION_ERROR: mailbox_user requires start_date and end_date for event search';
            if (entityTypes.length === 1) throw new Error(message);
            preValidationErrors.push(message);
          } else {
            // No date range: fall back to text-based search
            searches.push(searchEvents(queryString, top).then((results) => ({ type: 'events', provider: 'graph-search', results })));
          }
        }
      }

      if (searches.length === 0) {
        throw new Error(preValidationErrors[0] || 'VALIDATION_ERROR: no search providers selected');
      }

      const searchResults = await Promise.allSettled(searches);
      const allResults: FindResultItem[] = [];
      const providers: string[] = [];
      const errors: string[] = [...preValidationErrors];
      let fulfilledSearches = 0;

      for (const result of searchResults) {
        if (result.status === 'fulfilled') {
          fulfilledSearches += 1;
          allResults.push(...result.value.results);
          if (!providers.includes(result.value.provider)) providers.push(result.value.provider);
        } else {
          errors.push(result.reason?.message || String(result.reason));
        }
      }

      if (fulfilledSearches === 0) {
        throw new Error(errors[0] || 'UPSTREAM_ERROR: all search providers failed');
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
        ...(kql ? { kql } : {}),
        entity_types: entityTypes,
        ...(startDate ? { start_date: startDate } : {}),
        ...(endDate ? { end_date: endDate } : {}),
        ...(mailboxUser ? { mailbox_user: mailboxUser } : {}),
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
  }),
];
