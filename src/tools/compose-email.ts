import { z } from 'zod';
import { getGraph } from '../auth/index.js';
import {
  checkEmailAllowed,
  parseRecipients,
  sanitizeForLogs,
  sanitizeEmailHtml,
  graphMailboxPath,
  normalizeMailboxUser,
} from '../utils/helpers.js';
import { auditLogger } from '../utils/audit.js';
import { buildMailAttachments, createReplyDraft } from '../graph/mail.js';
import { ok, requireConfirm } from './results.js';
import { requireLoggedIn } from './shared.js';
import { writeAuditLog } from './write-audit.js';
import { defineTool } from './types.js';

export const composeEmailTools = [
  defineTool({
    name: 'compose_email',
    description:
      'Compose an email: draft, send, reply, or reply-all. For replies, provide message_id. ' +
      'Optional mailbox_user targets a shared mailbox. Write operations require confirm=true.',
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
        mailbox_user: z.string().min(1).optional(),
      })
      .strict(),
    run: async (params) => {
      await requireLoggedIn();
      const mode = params.mode;
      const bodyHtml = sanitizeEmailHtml(params.body_html);
      const mailboxUser = normalizeMailboxUser(params.mailbox_user);

      if (mode === 'reply' || mode === 'reply_all') {
        const messageId = params.message_id?.trim() ?? '';
        if (!messageId) throw new Error('VALIDATION_ERROR: message_id is required for reply/reply_all');

        const draft = await createReplyDraft(messageId, bodyHtml, mode === 'reply_all', mailboxUser || undefined);

        if (params.confirm === true) {
          await getGraph()
            .api(graphMailboxPath(`/messages/${encodeURIComponent(draft.id)}/send`, mailboxUser))
            .post({});
          await writeAuditLog(`compose_email_${mode}_send`, { message_id: messageId, ...(mailboxUser ? { mailbox_user: mailboxUser } : {}) });
          return ok(`${mode === 'reply_all' ? 'Reply-all' : 'Reply'} sent.`, { success: true, message_id: messageId, mode: 'send' });
        }

        await writeAuditLog(`compose_email_${mode}_draft`, { message_id: messageId, ...(mailboxUser ? { mailbox_user: mailboxUser } : {}) });
        return ok(`${mode === 'reply_all' ? 'Reply-all' : 'Reply'} draft created. Set confirm=true to send immediately.`, {
          ...draft,
          mode: 'draft',
        });
      }

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
          .api(graphMailboxPath('/sendMail', mailboxUser))
          .post({
            message: {
              subject: params.subject,
              body: { contentType: 'HTML', content: bodyHtml },
              toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
              attachments: attachmentBundle.attachments.length ? attachmentBundle.attachments : undefined,
            },
            saveToSentItems: true,
          });
        await writeAuditLog('compose_email_send', {
            recipientCount: recipients.length,
            subject: sanitizeForLogs(params.subject),
            attachment_count: attachmentBundle.count,
            attachment_bytes: attachmentBundle.totalBytes,
            ...(mailboxUser ? { mailbox_user: mailboxUser } : {}),
        });
        return ok('Email sent.', {
          success: true,
          attachment_count: attachmentBundle.count,
          attachment_bytes: attachmentBundle.totalBytes,
        });
      }

      const created = await getGraph()
        .api(graphMailboxPath('/messages', mailboxUser))
        .post({
          subject: params.subject,
          body: { contentType: 'HTML', content: bodyHtml },
          toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
          attachments: attachmentBundle.attachments.length ? attachmentBundle.attachments : undefined,
        });
      await writeAuditLog('compose_email_draft', {
          recipientCount: recipients.length,
          subject: sanitizeForLogs(params.subject),
          attachment_count: attachmentBundle.count,
          attachment_bytes: attachmentBundle.totalBytes,
          ...(mailboxUser ? { mailbox_user: mailboxUser } : {}),
      });
      return ok('Draft created.', {
        id: created.id,
        is_draft: true,
        attachment_count: attachmentBundle.count,
        attachment_bytes: attachmentBundle.totalBytes,
      });
    },
  }),
];
