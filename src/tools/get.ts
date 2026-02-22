import { z } from 'zod';
import { isLoggedIn, getGraph } from '../auth/index.js';
import { ok, includeFull } from '../utils/helpers.js';
import { pickMail } from '../graph/mail.js';
import { pickEvent, resolveTimezone } from '../graph/calendar.js';
import type { ToolSpec } from '../utils/types.js';

export const getTools: ToolSpec[] = [
  {
    name: 'get_email',
    description: 'Get a specific email by ID. Use after find to retrieve full details.',
    schema: z.object({ message_id: z.string().min(1), include_full: z.boolean().optional() }).strict(),
    run: async (params) => {
      if (!isLoggedIn()) throw new Error('AUTH_REQUIRED: not logged in');
      const message = await getGraph()
        .api(`/me/messages/${encodeURIComponent(String(params.message_id))}`)
        .select('id,subject,from,toRecipients,ccRecipients,bodyPreview,isRead,receivedDateTime,conversationId,webLink,body')
        .get();
      return ok('Message retrieved.', pickMail(message as Record<string, unknown>, includeFull(params)));
    },
  },
  {
    name: 'get_event',
    description: 'Get a specific calendar event by ID. Use after find to retrieve full details.',
    schema: z.object({ event_id: z.string().min(1), include_full: z.boolean().optional() }).strict(),
    run: async (params) => {
      if (!isLoggedIn()) throw new Error('AUTH_REQUIRED: not logged in');
      const event = await getGraph()
        .api(`/me/events/${encodeURIComponent(String(params.event_id))}`)
        .header('Prefer', `outlook.timezone="${resolveTimezone()}"`)
        .select('id,subject,start,end,location,organizer,attendees,responseStatus,isOnlineMeeting,onlineMeeting,webLink,bodyPreview')
        .get();
      return ok('Event retrieved.', pickEvent(event as Record<string, unknown>, includeFull(params)));
    },
  },
];
