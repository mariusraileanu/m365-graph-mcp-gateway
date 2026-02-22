import { z } from 'zod';
import { isLoggedIn, currentUser, getGraph } from '../auth/index.js';
import { ok, checkEmailAllowed, parseRecipients, requireConfirm, sanitizeForLogs, sanitizeEmailHtml } from '../utils/helpers.js';
import { auditLogger } from '../utils/audit.js';
import { buildMailAttachments, createReplyDraft } from '../graph/mail.js';
import type { ToolSpec } from '../utils/types.js';

export const composeEmailTools: ToolSpec[] = [
  {
    name: 'compose_email',
    description:
      'Compose an email: draft, send, reply, or reply-all. For replies, provide message_id. Write operations require confirm=true.',
    schema: z
      .object({
        mode: z.enum(['draft', 'send', 'reply', 'reply_all']),
        to: z.union([z.array(z.string().email()).min(1), z.string().min(1)]).optional(),
        subject: z.string().min(1).optional(),
        body_html: z.string().min(1),
        message_id: z.string().min(1).optional(),
        attachments: z
          .array(
            z
              .object({
                name: z.string().min(1),
                content_base64: z.string().min(1),
                content_type: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        attachment_refs: z
          .array(
            z
              .object({
                drive_id: z.string().min(1),
                item_id: z.string().min(1),
                name: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        confirm: z.boolean().optional(),
      })
      .strict(),
    run: async (params) => {
      if (!isLoggedIn()) throw new Error('AUTH_REQUIRED: not logged in');
      const mode = String(params.mode) as 'draft' | 'send' | 'reply' | 'reply_all';
      const bodyHtml = sanitizeEmailHtml(String(params.body_html));

      // Reply modes
      if (mode === 'reply' || mode === 'reply_all') {
        const messageId = String(params.message_id || '').trim();
        if (!messageId) throw new Error('VALIDATION_ERROR: message_id is required for reply/reply_all');

        if (params.confirm === true) {
          const endpoint =
            mode === 'reply_all'
              ? `/me/messages/${encodeURIComponent(messageId)}/replyAll`
              : `/me/messages/${encodeURIComponent(messageId)}/reply`;
          await getGraph()
            .api(endpoint)
            .post({
              message: { body: { contentType: 'HTML', content: bodyHtml } },
            });
          await auditLogger.log({
            action: `compose_email_${mode}_send`,
            user: currentUser() || 'unknown',
            details: { message_id: messageId },
            status: 'success',
          });
          return ok(`${mode === 'reply_all' ? 'Reply-all' : 'Reply'} sent.`, { success: true, message_id: messageId, mode: 'send' });
        }

        const draft = await createReplyDraft(messageId, bodyHtml, mode === 'reply_all');
        await auditLogger.log({
          action: `compose_email_${mode}_draft`,
          user: currentUser() || 'unknown',
          details: { message_id: messageId },
          status: 'success',
        });
        return ok(`${mode === 'reply_all' ? 'Reply-all' : 'Reply'} draft created. Set confirm=true to send immediately.`, {
          ...draft,
          mode: 'draft',
        });
      }

      // Draft and send modes
      if (!params.to) throw new Error('VALIDATION_ERROR: to is required for draft/send');
      if (!params.subject) throw new Error('VALIDATION_ERROR: subject is required for draft/send');

      const recipients = parseRecipients(params.to);
      for (const recipient of recipients) {
        const check = checkEmailAllowed(recipient);
        if (!check.allowed) throw new Error(`FORBIDDEN: ${check.reason}`);
      }
      const attachmentBundle = await buildMailAttachments(params);

      if (mode === 'send') {
        const gate = requireConfirm('compose_email (send)', params, {
          to: recipients,
          subject: params.subject,
          attachment_count: attachmentBundle.count,
          attachment_bytes: attachmentBundle.totalBytes,
        });
        if (gate) return gate;

        await getGraph()
          .api('/me/sendMail')
          .post({
            message: {
              subject: String(params.subject),
              body: { contentType: 'HTML', content: bodyHtml },
              toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
              attachments: attachmentBundle.attachments.length ? attachmentBundle.attachments : undefined,
            },
            saveToSentItems: true,
          });
        await auditLogger.log({
          action: 'compose_email_send',
          user: currentUser() || 'unknown',
          details: {
            recipientCount: recipients.length,
            subject: sanitizeForLogs(String(params.subject)),
            attachment_count: attachmentBundle.count,
            attachment_bytes: attachmentBundle.totalBytes,
          },
          status: 'success',
        });
        return ok('Email sent.', {
          success: true,
          attachment_count: attachmentBundle.count,
          attachment_bytes: attachmentBundle.totalBytes,
        });
      }

      // Draft mode
      const created = await getGraph()
        .api('/me/messages')
        .post({
          subject: String(params.subject),
          body: { contentType: 'HTML', content: bodyHtml },
          toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
          attachments: attachmentBundle.attachments.length ? attachmentBundle.attachments : undefined,
        });
      await auditLogger.log({
        action: 'compose_email_draft',
        user: currentUser() || 'unknown',
        details: {
          recipientCount: recipients.length,
          subject: sanitizeForLogs(String(params.subject)),
          attachment_count: attachmentBundle.count,
          attachment_bytes: attachmentBundle.totalBytes,
        },
        status: 'success',
      });
      return ok('Draft created.', {
        id: created.id,
        is_draft: true,
        attachment_count: attachmentBundle.count,
        attachment_bytes: attachmentBundle.totalBytes,
      });
    },
  },
];
