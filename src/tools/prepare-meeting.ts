import { z } from 'zod';
import { isLoggedIn, getGraph } from '../auth/index.js';
import { loadConfig } from '../config/index.js';
import { ok, compactText } from '../utils/helpers.js';
import { copilotRetrieval, formatRetrievalResults } from '../graph/retrieval.js';
import { pickEvent, resolveTimezone } from '../graph/calendar.js';
import { log } from '../utils/log.js';
import type { ToolSpec } from '../utils/types.js';

export const prepareMeetingTools: ToolSpec[] = [
  {
    name: 'prepare_meeting',
    description:
      'Gather context for an upcoming meeting: related emails, files, past meetings, and attendee context. Returns a briefing package.',
    schema: z
      .object({
        event_id: z.string().optional(),
        subject: z.string().optional(),
        max_chars: z.number().int().positive().max(50000).optional(),
      })
      .strict(),
    run: async (params) => {
      if (!isLoggedIn()) throw new Error('AUTH_REQUIRED: not logged in');

      let meetingSubject = '';
      let meetingDetails: Record<string, unknown> | null = null;
      const attendeeNames: string[] = [];

      if (params.event_id) {
        const event = await getGraph()
          .api(`/me/events/${encodeURIComponent(String(params.event_id))}`)
          .header('Prefer', `outlook.timezone="${resolveTimezone()}"`)
          .select('id,subject,start,end,location,organizer,attendees,bodyPreview,isOnlineMeeting,onlineMeeting,webLink')
          .get();
        meetingSubject = String(event.subject || '');
        meetingDetails = pickEvent(event as Record<string, unknown>, true);

        const attendees = Array.isArray(event.attendees) ? event.attendees : [];
        for (const att of attendees) {
          const name = att?.emailAddress?.name || att?.emailAddress?.address;
          if (name) attendeeNames.push(String(name));
        }
        const organizer = event?.organizer?.emailAddress?.name || event?.organizer?.emailAddress?.address;
        if (organizer) attendeeNames.push(String(organizer));
      } else if (params.subject) {
        meetingSubject = String(params.subject);
      } else {
        throw new Error('VALIDATION_ERROR: provide event_id or subject');
      }

      if (!meetingSubject.trim()) {
        throw new Error('VALIDATION_ERROR: could not determine meeting subject');
      }

      // Search for related documents via Copilot Retrieval API
      const searchQuery = attendeeNames.length > 0 ? `${meetingSubject} ${attendeeNames.slice(0, 5).join(' ')}` : meetingSubject;

      let briefingText = '';
      let provider = 'graph';
      const citations: Array<Record<string, string>> = [];

      try {
        const results = await copilotRetrieval({ queryString: searchQuery, maxResults: 10 });
        if (results.length > 0) {
          provider = 'copilot-retrieval';
          const formatted = formatRetrievalResults(results);
          briefingText = `Meeting Briefing: "${meetingSubject}"\n\nRelated Documents:\n${formatted.text}`;
          citations.push(...formatted.citations);
        }
      } catch (err) {
        log.warn('Copilot Retrieval failed for meeting prep', { error: (err as Error).message });
      }

      // Fallback: search via Graph Search API
      if (!briefingText) {
        try {
          const response = await getGraph()
            .api('/search/query')
            .post({
              requests: [{ entityTypes: ['driveItem', 'message'], query: { queryString: meetingSubject }, from: 0, size: 10 }],
            });
          const values = (response as { value?: unknown[] }).value ?? [];
          const hits =
            (
              values[0] as
                | { hitsContainers?: Array<{ hits?: Array<{ resource?: Record<string, unknown>; summary?: string }> }> }
                | undefined
            )?.hitsContainers?.[0]?.hits ?? [];
          if (hits.length > 0) {
            provider = 'graph-search';
            briefingText =
              `Meeting Briefing: "${meetingSubject}"\n\nRelated content:\n` +
              hits
                .map(
                  (h, i) =>
                    `[${i + 1}] ${String((h.resource as Record<string, unknown>)?.name || (h.resource as Record<string, unknown>)?.subject || 'Untitled')}: ${h.summary || ''}`,
                )
                .join('\n');
          }
        } catch (err) {
          log.warn('Graph Search failed for meeting prep', { error: (err as Error).message });
        }
      }

      if (!briefingText) {
        briefingText = `No related content found for meeting: "${meetingSubject}"`;
      }

      const summary = compactText(briefingText, Number.parseInt(String(params.max_chars || loadConfig().output.defaultMaxChars), 10));

      return ok(`Meeting briefing prepared for: "${meetingSubject}"`, {
        provider,
        meeting_subject: meetingSubject,
        meeting: meetingDetails,
        attendees: attendeeNames.length ? attendeeNames : undefined,
        briefing: summary.text,
        truncated: summary.truncated,
        citations: citations.length > 0 ? citations.slice(0, 30) : undefined,
      });
    },
  },
];
