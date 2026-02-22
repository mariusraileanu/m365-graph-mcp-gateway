import { z } from 'zod';
import { isLoggedIn, currentUser, getGraph } from '../auth/index.js';
import { ok, requireConfirm, sanitizeForLogs, escapeHtml, sanitizeEmailHtml } from '../utils/helpers.js';
import { auditLogger } from '../utils/audit.js';
import { pickEvent, resolveTimezone } from '../graph/calendar.js';
import type { ToolSpec } from '../utils/types.js';

export const scheduleMeetingTools: ToolSpec[] = [
  {
    name: 'schedule_meeting',
    description:
      'Schedule a meeting. Provide explicit start/end, or provide preferred_start/preferred_end + duration_minutes to auto-find a free slot. Supports Teams meetings and agendas. Requires confirm=true.',
    schema: z
      .object({
        subject: z.string().min(1),
        attendees: z.array(z.string().email()).optional(),
        start: z.string().datetime({ offset: true }).optional(),
        end: z.string().datetime({ offset: true }).optional(),
        preferred_start: z.string().datetime({ offset: true }).optional(),
        preferred_end: z.string().datetime({ offset: true }).optional(),
        duration_minutes: z.number().int().positive().max(480).optional(),
        timezone: z.string().optional(),
        agenda: z.string().optional(),
        teams_meeting: z.boolean().optional(),
        body_html: z.string().optional(),
        confirm: z.boolean().optional(),
      })
      .strict(),
    run: async (params) => {
      if (!isLoggedIn()) throw new Error('AUTH_REQUIRED: not logged in');

      const attendees = Array.isArray(params.attendees) ? params.attendees.map((x) => String(x)) : [];
      const teamsMeeting = params.teams_meeting === true;
      const agenda = typeof params.agenda === 'string' ? params.agenda.trim() : '';
      const durationMinutes = Number.parseInt(String(params.duration_minutes ?? 60), 10);
      const tz = resolveTimezone(typeof params.timezone === 'string' && params.timezone.trim() ? params.timezone.trim() : undefined);

      let meetingStart: string;
      let meetingEnd: string;

      if (params.start && params.end) {
        meetingStart = String(params.start);
        meetingEnd = String(params.end);
      } else if (params.preferred_start && params.preferred_end) {
        // Auto-find a free slot
        const schedule = await getGraph()
          .api('/me/calendar/getSchedule')
          .post({
            schedules: [currentUser() || ''],
            startTime: { dateTime: String(params.preferred_start), timeZone: tz },
            endTime: { dateTime: String(params.preferred_end), timeZone: tz },
            availabilityViewInterval: 30,
          });

        const busySlots =
          (schedule?.value?.[0] as { scheduleItems?: Array<{ start: { dateTime: string }; end: { dateTime: string } }> } | undefined)
            ?.scheduleItems || [];
        const windowStart = new Date(String(params.preferred_start));
        const windowEnd = new Date(String(params.preferred_end));
        let foundSlot: { start: string; end: string } | null = null;

        for (let cursor = new Date(windowStart); cursor < windowEnd; cursor = new Date(cursor.getTime() + 30 * 60_000)) {
          const slotEnd = new Date(cursor.getTime() + durationMinutes * 60_000);
          if (slotEnd > windowEnd) break;
          const overlaps = busySlots.some((slot) => {
            const bs = new Date(slot.start.dateTime);
            const be = new Date(slot.end.dateTime);
            return cursor < be && bs < slotEnd;
          });
          if (!overlaps) {
            foundSlot = { start: cursor.toISOString(), end: slotEnd.toISOString() };
            break;
          }
        }

        if (!foundSlot) {
          return ok('No free slot found in the preferred window.', {
            success: false,
            preferred_start: params.preferred_start,
            preferred_end: params.preferred_end,
            duration_minutes: durationMinutes,
            suggestion: 'Try a wider time window or shorter duration.',
          });
        }

        meetingStart = foundSlot.start;
        meetingEnd = foundSlot.end;
      } else {
        throw new Error('VALIDATION_ERROR: provide start+end or preferred_start+preferred_end');
      }

      const gate = requireConfirm('schedule_meeting', params, {
        subject: params.subject,
        start: meetingStart,
        end: meetingEnd,
        attendees,
        teams_meeting: teamsMeeting,
        agenda,
        duration_minutes: durationMinutes,
      });
      if (gate) return gate;

      const bodyHtml =
        typeof params.body_html === 'string' && params.body_html.trim()
          ? sanitizeEmailHtml(String(params.body_html))
          : agenda
            ? `<p>${escapeHtml(agenda).replace(/\n/g, '<br/>')}</p>`
            : undefined;

      const event = await getGraph()
        .api('/me/events')
        .post({
          subject: String(params.subject),
          start: { dateTime: meetingStart, timeZone: tz },
          end: { dateTime: meetingEnd, timeZone: tz },
          body: bodyHtml ? { contentType: 'HTML', content: bodyHtml } : undefined,
          attendees: attendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
          isOnlineMeeting: teamsMeeting,
          onlineMeetingProvider: teamsMeeting ? 'teamsForBusiness' : undefined,
        });

      await auditLogger.log({
        action: 'schedule_meeting',
        user: currentUser() || 'unknown',
        details: {
          subject: sanitizeForLogs(String(params.subject)),
          attendeeCount: attendees.length,
          start: meetingStart,
          teams_meeting: teamsMeeting,
          has_agenda: Boolean(agenda || bodyHtml),
        },
        status: 'success',
      });
      return ok('Meeting scheduled.', pickEvent(event as Record<string, unknown>, false));
    },
  },
];
