import { loadConfig } from '../config/index.js';
import { getGraph, getAccessToken } from '../auth/index.js';
import { compactText, stripHtml } from '../utils/helpers.js';
import type { GraphFileAttachment } from '../utils/types.js';

export function pickMail(message: Record<string, unknown>, includeFullPayload: boolean): Record<string, unknown> {
  const minimal = {
    id: message.id,
    subject: message.subject,
    from: (message.from as { emailAddress?: { address?: string; name?: string } } | undefined)?.emailAddress,
    sent_at: message.sentDateTime,
    received_at: message.receivedDateTime,
    is_read: message.isRead,
    body_preview: message.bodyPreview,
  };
  if (!includeFullPayload) return minimal;

  const bodyRaw = (message.body as { content?: string } | undefined)?.content || '';
  const compact = compactText(stripHtml(String(bodyRaw)), loadConfig().output.defaultMaxChars);
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
  const item = await getGraph()
    .api(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`)
    .select('id,name,size,file')
    .get();
  const fileName = String(preferredName || item?.name || `file-${itemId}`);
  const mimeType = String(item?.file?.mimeType || 'application/octet-stream');

  const token = await getAccessToken();
  const endpoint = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`UPSTREAM_ERROR: attachment fetch failed (${response.status})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ATTACHMENT_BYTES_SINGLE) {
    throw new Error(`VALIDATION_ERROR: attachment '${fileName}' exceeds ${MAX_ATTACHMENT_BYTES_SINGLE} bytes`);
  }

  return {
    bytes: bytes.length,
    attachment: {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: fileName,
      contentType: response.headers.get('content-type') || mimeType,
      contentBytes: bytes.toString('base64'),
    },
  };
}

export async function buildMailAttachments(
  params: Record<string, unknown>,
): Promise<{ attachments: GraphFileAttachment[]; count: number; totalBytes: number }> {
  const inlineRaw = Array.isArray(params.attachments) ? (params.attachments as Array<Record<string, unknown>>) : [];
  const refsRaw = Array.isArray(params.attachment_refs) ? (params.attachment_refs as Array<Record<string, unknown>>) : [];

  const totalCount = inlineRaw.length + refsRaw.length;
  if (totalCount > MAX_ATTACHMENT_COUNT) {
    throw new Error(`VALIDATION_ERROR: attachment count exceeds ${MAX_ATTACHMENT_COUNT}`);
  }

  const attachments: GraphFileAttachment[] = [];
  let totalBytes = 0;

  for (const inline of inlineRaw) {
    const name = String(inline.name || '').trim();
    const contentBase64Raw = String(inline.content_base64 || '').trim();
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
      contentType: String(inline.content_type || 'application/octet-stream'),
      contentBytes: bytes.toString('base64'),
    });
  }

  for (const ref of refsRaw) {
    const driveId = String(ref.drive_id || '').trim();
    const itemId = String(ref.item_id || '').trim();
    if (!driveId || !itemId) {
      throw new Error('VALIDATION_ERROR: attachment_refs entries require drive_id and item_id');
    }
    const resolved = await fetchDriveItemAttachment(driveId, itemId, typeof ref.name === 'string' ? ref.name : undefined);
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
): Promise<{ id: string; source_message_id: string; is_draft: true }> {
  const endpoint = replyAll
    ? `/me/messages/${encodeURIComponent(messageId)}/createReplyAll`
    : `/me/messages/${encodeURIComponent(messageId)}/createReply`;
  const created = await getGraph().api(endpoint).post({});
  const draftId = String(created?.id || '').trim();
  if (!draftId) throw new Error('UPSTREAM_ERROR: failed to create reply draft');

  if (bodyHtml.trim()) {
    const current = await getGraph()
      .api(`/me/messages/${encodeURIComponent(draftId)}`)
      .select('body')
      .get();
    const merged = `${bodyHtml}<br><br>${String(current?.body?.content || '')}`;
    await getGraph()
      .api(`/me/messages/${encodeURIComponent(draftId)}`)
      .patch({
        body: { contentType: 'HTML', content: merged },
      });
  }

  return { id: draftId, source_message_id: messageId, is_draft: true };
}
