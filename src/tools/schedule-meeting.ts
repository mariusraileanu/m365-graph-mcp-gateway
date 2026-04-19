import { z } from 'zod';
import { currentUser, getGraph } from '../auth/index.js';
import {
  sanitizeForLogs,
  escapeHtml,
  sanitizeEmailHtml,
  checkEmailAllowed,
  graphMailboxPath,
  normalizeMailboxUser,
} from '../utils/helpers.js';
import { pickEvent, resolveTimezone } from '../graph/calendar.js';
import { ok, requireConfirm } from './results.js';
import { requireLoggedIn } from './shared.js';
import { writeAuditLog } from './write-audit.js';
import { defineTool } from './types.js';
import type { GraphEvent } from '../graph/types.js';

export const scheduleMeetingTools = [
  defineTool({
    name: 'schedule_meeting',
    description:
      'Schedule a meeting. Provide explicit start/end, or provide preferred_start/preferred_end + duration_minutes to auto-find a free slot. ' +
      'Supports Teams meetings and agendas. Optional mailbox_user targets a shared calendar. Requires confirm=true.',
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
        mailbox_user: z.string().min(1).optional(),
      })
      .strict(),
    run: async (params) => {
      await requireLoggedIn();
      const mailboxUser = normalizeMailboxUser(params.mailbox_user);

      const attendees = params.attendees ?? [];
      for (const attendee of attendees) {
        const check = checkEmailAllowed(attendee);
        if (!check.allowed) throw new Error(`FORBIDDEN: ${check.reason}`);
      }
      const teamsMeeting = params.teams_meeting === true;
      const agenda = params.agenda?.trim() ?? '';
      const durationMinutes = params.duration_minutes ?? 60;
      const tz = resolveTimezone(params.timezone?.trim() ? params.timezone.trim() : undefined);

      let meetingStart: string;
      let meetingEnd: string;

      if (params.start && params.end) {
        meetingStart = params.start;
        meetingEnd = params.end;
      } else if (params.preferred_start && params.preferred_end) {
        // Auto-find a free slot
        const schedule = await getGraph()
          .api(graphMailboxPath('/calendar/getSchedule', mailboxUser))
          .post({
            schedules: [mailboxUser || (await currentUser()) || ''],
            startTime: { dateTime: params.preferred_start, timeZone: tz },
            endTime: { dateTime: params.preferred_end, timeZone: tz },
            availabilityViewInterval: 30,
          });

        const scheduleRoot = schedule as { value?: Array<{ scheduleItems?: Array<{ start: { dateTime: string }; end: { dateTime: string } }> }> };
        const busySlots = scheduleRoot.value?.[0]?.scheduleItems;
        if (!Array.isArray(busySlots)) {
          throw new Error('UPSTREAM_ERROR: getSchedule response missing scheduleItems');
        }
        const windowStart = new Date(params.preferred_start);
        const windowEnd = new Date(params.preferred_end);
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

      const subject = params.subject;
      const bodyHtml = params.body_html?.trim() ? sanitizeEmailHtml(params.body_html) : agenda ? `<p>${escapeHtml(agenda).replace(/\n/g, '<br/>')}</p>` : undefined;

      const event: GraphEvent = await getGraph()
        .api(graphMailboxPath('/events', mailboxUser))
        .post({
          subject,
          start: { dateTime: meetingStart, timeZone: tz },
          end: { dateTime: meetingEnd, timeZone: tz },
          body: bodyHtml ? { contentType: 'HTML', content: bodyHtml } : undefined,
          attendees: attendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
          isOnlineMeeting: teamsMeeting,
          onlineMeetingProvider: teamsMeeting ? 'teamsForBusiness' : undefined,
        });

      await writeAuditLog('schedule_meeting', {
        subject: sanitizeForLogs(subject),
        attendeeCount: attendees.length,
        start: meetingStart,
        teams_meeting: teamsMeeting,
        has_agenda: Boolean(agenda || bodyHtml),
        ...(mailboxUser ? { mailbox_user: mailboxUser } : {}),
      });
      return ok('Meeting scheduled.', {
        ...(mailboxUser ? { mailbox_user: mailboxUser } : {}),
        ...pickEvent(event, false),
      });
    },
  }),
];
