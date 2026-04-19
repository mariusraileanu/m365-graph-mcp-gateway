import { z } from 'zod';
import { getGraph } from '../auth/index.js';
import { sanitizeEmailHtml, graphMailboxPath, normalizeMailboxUser } from '../utils/helpers.js';
import { prependHtmlToDraftBody } from '../graph/mail.js';
import { ok, requireConfirm } from './results.js';
import { requireLoggedIn } from './shared.js';
import { writeAuditLog } from './write-audit.js';
import { defineTool } from './types.js';

export const respondMeetingTools = [
  defineTool({
    name: 'respond_to_meeting',
    description:
      'Respond to a meeting invitation (accept/decline/tentative), cancel a meeting you organized, or create a reply-all draft to meeting attendees. ' +
      'Optional mailbox_user targets a shared calendar/mailbox. Requires confirm=true for accept/decline/cancel.',
    schema: z
      .object({
        event_id: z.string().min(1),
        action: z.enum(['accept', 'decline', 'tentativelyAccept', 'cancel', 'reply_all_draft']),
        comment: z.string().optional(),
        body_html: z.string().optional(),
        confirm: z.boolean().optional(),
        mailbox_user: z.string().min(1).optional(),
      })
      .strict(),
    run: async (params) => {
      await requireLoggedIn();
      const eventId = params.event_id.trim();
      const action = params.action;
      const mailboxUser = normalizeMailboxUser(params.mailbox_user);

      if (action === 'reply_all_draft') {
        const event = await getGraph()
          .api(graphMailboxPath(`/events/${encodeURIComponent(eventId)}`, mailboxUser))
          .select('id,subject,organizer')
          .get();
        const organizer = event?.organizer?.emailAddress?.address || event?.organizer?.emailAddress?.name || '';
        const query = `${event.subject || ''} ${organizer}`.trim();
        if (!query) throw new Error('NOT_FOUND: could not derive query for invite message');

        const searched = await getGraph()
          .api(graphMailboxPath('/messages', mailboxUser))
          .header('ConsistencyLevel', 'eventual')
          .search(`"${query.replace(/"/g, '').trim()}"`)
          .select('id,subject')
          .top(30)
          .get();

        const invite = (searched.value || [])[0];
        if (!invite?.id) throw new Error('NOT_FOUND: could not find meeting invite message for reply-all');

        const created = await getGraph()
          .api(graphMailboxPath(`/messages/${encodeURIComponent(String(invite.id))}/createReplyAll`, mailboxUser))
          .post({});
        const draftId = String(created?.id || '').trim();
        if (!draftId) throw new Error('UPSTREAM_ERROR: failed to create reply-all draft');

        await prependHtmlToDraftBody(draftId, sanitizeEmailHtml(params.body_html ?? ''), mailboxUser || undefined);

        await writeAuditLog('respond_to_meeting_reply_all_draft', {
          event_id: eventId,
          draft_id: draftId,
          source_message_id: invite.id,
          ...(mailboxUser ? { mailbox_user: mailboxUser } : {}),
        });
        return ok('Reply-all draft created for meeting attendees.', {
          id: draftId,
          source_message_id: invite.id,
          is_draft: true,
          ...(mailboxUser ? { mailbox_user: mailboxUser } : {}),
        });
      }
      if (action === 'cancel') {
        const comment = typeof params.comment === 'string' ? params.comment : '';
        const gate = requireConfirm('respond_to_meeting (cancel)', params, { event_id: eventId, comment });
        if (gate) return gate;

        await getGraph()
          .api(graphMailboxPath(`/events/${encodeURIComponent(eventId)}/cancel`, mailboxUser))
          .post(comment ? { comment } : {});
        await writeAuditLog('respond_to_meeting_cancel', {
          event_id: eventId,
          has_comment: Boolean(comment),
          ...(mailboxUser ? { mailbox_user: mailboxUser } : {}),
        });
        return ok('Meeting cancelled.', { success: true, event_id: eventId, ...(mailboxUser ? { mailbox_user: mailboxUser } : {}) });
      }

      const gate = requireConfirm('respond_to_meeting', params, { event_id: eventId, action, comment: params.comment });
      if (gate) return gate;

      const payload = typeof params.comment === 'string' && params.comment.trim() ? { comment: params.comment } : {};
      await getGraph()
        .api(graphMailboxPath(`/events/${encodeURIComponent(eventId)}/${action}`, mailboxUser))
        .post(payload);
      await writeAuditLog('respond_to_meeting', { event_id: eventId, action, ...(mailboxUser ? { mailbox_user: mailboxUser } : {}) });
      return ok(`Meeting response sent: ${action}.`, {
        success: true,
        event_id: eventId,
        action,
        ...(mailboxUser ? { mailbox_user: mailboxUser } : {}),
      });
    },
  }),
];
