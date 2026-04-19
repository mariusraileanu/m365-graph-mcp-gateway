import { loadConfig } from '../config/index.js';
import { getGraph } from '../auth/index.js';
import { compactText, stripHtml, graphMailboxPath } from '../utils/helpers.js';
import { downloadGraphContent } from './http.js';
import type { GraphFileAttachment, GraphMailBody, GraphMailMessage } from './types.js';

type GraphDriveItemAttachmentSource = {
  name?: string;
  file?: {
    mimeType?: string;
  };
};

export type InlineAttachmentInput = {
  name?: string;
  content_base64?: string;
  content_type?: string;
};

export type AttachmentRefInput = {
  drive_id?: string;
  item_id?: string;
  name?: string;
};

export interface MailAttachmentParams {
  attachments?: InlineAttachmentInput[];
  attachment_refs?: AttachmentRefInput[];
}

export async function prependHtmlToDraftBody(draftId: string, bodyHtml: string, mailboxUser?: string): Promise<void> {
  if (!bodyHtml.trim()) return;

  const messagePath = graphMailboxPath(`/messages/${encodeURIComponent(draftId)}`, mailboxUser);
  const current = (await getGraph().api(messagePath).select('body').get()) as { body?: GraphMailBody };
  const existingBody = current.body?.content ?? '';
  const merged = `${bodyHtml}<br><br>${existingBody}`;

  await getGraph().api(messagePath).patch({
    body: { contentType: 'HTML', content: merged },
  });
}

export function pickMail(message: GraphMailMessage, includeFullPayload: boolean): Record<string, unknown> {
  const minimal = {
    id: message.id,
    subject: message.subject,
    from: message.from?.emailAddress,
    sent_at: message.sentDateTime,
    received_at: message.receivedDateTime,
    is_read: message.isRead,
    body_preview: message.bodyPreview,
  };
  if (!includeFullPayload) return minimal;

  const bodyRaw = message.body?.content ?? '';
  const compact = compactText(stripHtml(bodyRaw), loadConfig().output.defaultMaxChars);
  return {
    ...minimal,
    to: message.toRecipients,
    cc: message.ccRecipients,
    conversation_id: message.conversationId,
    body_text: compact.text,
    body_truncated: compact.truncated,
    web_link: message.webLink,
  };
}

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES_TOTAL = 10 * 1024 * 1024; // 10 MB total
const MAX_ATTACHMENT_BYTES_SINGLE = 5 * 1024 * 1024; // 5 MB per file

async function fetchDriveItemAttachment(
  driveId: string,
  itemId: string,
  preferredName?: string,
): Promise<{ attachment: GraphFileAttachment; bytes: number }> {
  const item = (await getGraph()
    .api(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`)
    .select('id,name,size,file')
    .get()) as GraphDriveItemAttachmentSource;
  const fileName = preferredName || item.name || `file-${itemId}`;
  const mimeType = item.file?.mimeType || 'application/octet-stream';

  const endpoint = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
  const { buffer: bytes, contentType } = await downloadGraphContent(endpoint, 'UPSTREAM_ERROR: attachment fetch failed');
  if (bytes.length > MAX_ATTACHMENT_BYTES_SINGLE) {
    throw new Error(`VALIDATION_ERROR: attachment '${fileName}' exceeds ${MAX_ATTACHMENT_BYTES_SINGLE} bytes`);
  }

  return {
    bytes: bytes.length,
    attachment: {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: fileName,
      contentType: contentType || mimeType,
      contentBytes: bytes.toString('base64'),
    },
  };
}

export async function buildMailAttachments(
  params: MailAttachmentParams,
): Promise<{ attachments: GraphFileAttachment[]; count: number; totalBytes: number }> {
  const inlineRaw = params.attachments ?? [];
  const refsRaw = params.attachment_refs ?? [];

  const totalCount = inlineRaw.length + refsRaw.length;
  if (totalCount > MAX_ATTACHMENT_COUNT) {
    throw new Error(`VALIDATION_ERROR: attachment count exceeds ${MAX_ATTACHMENT_COUNT}`);
  }

  const attachments: GraphFileAttachment[] = [];
  let totalBytes = 0;

  for (const inline of inlineRaw) {
    const name = (inline.name || '').trim();
    const contentBase64Raw = (inline.content_base64 || '').trim();
    if (!name || !contentBase64Raw) {
      throw new Error('VALIDATION_ERROR: inline attachment requires name and content_base64');
    }
    const contentBase64 = contentBase64Raw.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    const bytes = Buffer.from(contentBase64, 'base64');
    if (!bytes.length) {
      throw new Error(`VALIDATION_ERROR: attachment '${name}' has invalid/empty base64 content`);
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES_SINGLE) {
      throw new Error(`VALIDATION_ERROR: attachment '${name}' exceeds ${MAX_ATTACHMENT_BYTES_SINGLE} bytes`);
    }
    totalBytes += bytes.length;
    attachments.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name,
      contentType: inline.content_type || 'application/octet-stream',
      contentBytes: bytes.toString('base64'),
    });
  }

  for (const ref of refsRaw) {
    const driveId = (ref.drive_id || '').trim();
    const itemId = (ref.item_id || '').trim();
    if (!driveId || !itemId) {
      throw new Error('VALIDATION_ERROR: attachment_refs entries require drive_id and item_id');
    }
    const resolved = await fetchDriveItemAttachment(driveId, itemId, ref.name || undefined);
    totalBytes += resolved.bytes;
    attachments.push(resolved.attachment);
  }

  if (totalBytes > MAX_ATTACHMENT_BYTES_TOTAL) {
    throw new Error(`VALIDATION_ERROR: total attachment size exceeds ${MAX_ATTACHMENT_BYTES_TOTAL} bytes`);
  }

  return { attachments, count: attachments.length, totalBytes };
}

export async function createReplyDraft(
  messageId: string,
  bodyHtml: string,
  replyAll: boolean,
  mailboxUser?: string,
): Promise<{ id: string; source_message_id: string; is_draft: true }> {
  const endpoint = graphMailboxPath(
    replyAll ? `/messages/${encodeURIComponent(messageId)}/createReplyAll` : `/messages/${encodeURIComponent(messageId)}/createReply`,
    mailboxUser,
  );
  const created = (await getGraph().api(endpoint).post({})) as { id?: string };
  const draftId = (created.id || '').trim();
  if (!draftId) throw new Error('UPSTREAM_ERROR: failed to create reply draft');

  await prependHtmlToDraftBody(draftId, bodyHtml, mailboxUser);

  return { id: draftId, source_message_id: messageId, is_draft: true };
}
