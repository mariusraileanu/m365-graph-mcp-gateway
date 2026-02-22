import { z } from 'zod';
import { isLoggedIn, currentUser, getGraph } from '../auth/index.js';
import { ok, requireConfirm, sanitizeEmailHtml } from '../utils/helpers.js';
import { auditLogger } from '../utils/audit.js';
import type { ToolSpec } from '../utils/types.js';

export const respondMeetingTools: ToolSpec[] = [
  {
    name: 'respond_to_meeting',
    description:
      'Respond to a meeting invitation (accept/decline/tentative), cancel a meeting you organized, or create a reply-all draft to meeting attendees. Requires confirm=true for accept/decline/cancel.',
    schema: z
      .object({
        event_id: z.string().min(1),
        action: z.enum(['accept', 'decline', 'tentativelyAccept', 'cancel', 'reply_all_draft']),
        comment: z.string().optional(),
        body_html: z.string().optional(),
        confirm: z.boolean().optional(),
      })
      .strict(),
    run: async (params) => {
      if (!isLoggedIn()) throw new Error('AUTH_REQUIRED: not logged in');
      const eventId = String(params.event_id).trim();
      const action = String(params.action) as 'accept' | 'decline' | 'tentativelyAccept' | 'cancel' | 'reply_all_draft';

      if (action === 'reply_all_draft') {
        const event = await getGraph()
          .api(`/me/events/${encodeURIComponent(eventId)}`)
          .select('id,subject,organizer')
          .get();
        const organizer = event?.organizer?.emailAddress?.address || event?.organizer?.emailAddress?.name || '';
        const query = `${event.subject || ''} ${organizer}`.trim();
        if (!query) throw new Error('NOT_FOUND: could not derive query for invite message');

        const searched = await getGraph()
          .api('/me/messages')
          .header('ConsistencyLevel', 'eventual')
          .search(`"${query.replace(/"/g, '').trim()}"`)
          .select('id,subject')
          .top(30)
          .get();

        const invite = (searched.value || [])[0];
        if (!invite?.id) throw new Error('NOT_FOUND: could not find meeting invite message for reply-all');

        const created = await getGraph()
          .api(`/me/messages/${encodeURIComponent(String(invite.id))}/createReplyAll`)
          .post({});
        const draftId = String(created?.id || '').trim();
        if (!draftId) throw new Error('UPSTREAM_ERROR: failed to create reply-all draft');

        if (String(params.body_html || '').trim()) {
          const current = await getGraph()
            .api(`/me/messages/${encodeURIComponent(draftId)}`)
            .select('body')
            .get();
          const merged = `${sanitizeEmailHtml(String(params.body_html))}<br><br>${String(current?.body?.content || '')}`;
          await getGraph()
            .api(`/me/messages/${encodeURIComponent(draftId)}`)
            .patch({ body: { contentType: 'HTML', content: merged } });
        }

        return ok('Reply-all draft created for meeting attendees.', { id: draftId, source_message_id: invite.id, is_draft: true });
      }

      if (action === 'cancel') {
        const comment = typeof params.comment === 'string' ? params.comment : '';
        const gate = requireConfirm('respond_to_meeting (cancel)', params, { event_id: eventId, comment });
        if (gate) return gate;

        await getGraph()
          .api(`/me/events/${encodeURIComponent(eventId)}/cancel`)
          .post(comment ? { comment } : {});
        await auditLogger.log({
          action: 'respond_to_meeting_cancel',
          user: currentUser() || 'unknown',
          details: { event_id: eventId, has_comment: Boolean(comment) },
          status: 'success',
        });
        return ok('Meeting cancelled.', { success: true, event_id: eventId });
      }

      // RSVP: accept, decline, tentativelyAccept
      const gate = requireConfirm('respond_to_meeting', params, { event_id: eventId, action, comment: params.comment });
      if (gate) return gate;

      const payload = typeof params.comment === 'string' && params.comment.trim() ? { comment: params.comment } : {};
      await getGraph()
        .api(`/me/events/${encodeURIComponent(eventId)}/${action}`)
        .post(payload);
      await auditLogger.log({
        action: 'respond_to_meeting',
        user: currentUser() || 'unknown',
        details: { event_id: eventId, action },
        status: 'success',
      });
      return ok(`Meeting response sent: ${action}.`, { success: true, event_id: eventId, action });
    },
  },
];
