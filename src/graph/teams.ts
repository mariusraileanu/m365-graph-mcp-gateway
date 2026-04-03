import { getGraph, getAccessToken } from '../auth/index.js';
import { compactText, stripHtml, escapeODataString } from '../utils/helpers.js';
import { loadConfig } from '../config/index.js';

// ── Picker functions ────────────────────────────────────────────────────────

export function pickChat(chat: Record<string, unknown>, includeFullPayload: boolean): Record<string, unknown> {
  const meetingInfo = chat.onlineMeetingInfo as { joinWebUrl?: string; calendarEventId?: string } | undefined;
  const lastPreview = chat.lastMessagePreview as { body?: { content?: string }; createdDateTime?: string } | undefined;
  const minimal: Record<string, unknown> = {
    id: chat.id,
    topic: chat.topic,
    chat_type: chat.chatType,
    created_at: chat.createdDateTime,
    last_updated_at: chat.lastUpdatedDateTime,
  };
  if (meetingInfo?.joinWebUrl) {
    minimal.join_web_url = meetingInfo.joinWebUrl;
  }
  if (lastPreview) {
    minimal.last_message_preview = lastPreview.body?.content;
    minimal.last_message_at = lastPreview.createdDateTime;
  }
  if (!includeFullPayload) return minimal;
  return {
    ...minimal,
    tenant_id: chat.tenantId,
    web_url: chat.webUrl,
    online_meeting_info: chat.onlineMeetingInfo,
    members: chat.members,
  };
}

export function pickMessage(message: Record<string, unknown>, includeFullPayload: boolean): Record<string, unknown> {
  const from = message.from as { user?: { displayName?: string; id?: string } } | undefined;
  const body = message.body as { contentType?: string; content?: string } | undefined;
  const bodyContent = body?.content || '';
  const isHtml = body?.contentType === 'html';
  const plainText = isHtml ? stripHtml(bodyContent) : bodyContent;
  const compact = compactText(plainText, loadConfig().output.defaultMaxChars);

  const minimal: Record<string, unknown> = {
    id: message.id,
    message_type: message.messageType,
    from_name: from?.user?.displayName,
    from_id: from?.user?.id,
    created_at: message.createdDateTime,
    body_text: compact.text,
    body_truncated: compact.truncated,
  };
  if (!includeFullPayload) return minimal;
  return {
    ...minimal,
    last_modified_at: message.lastModifiedDateTime,
    importance: message.importance,
    web_url: message.webUrl,
    attachments: message.attachments,
  };
}

export function pickTranscript(transcript: Record<string, unknown>): Record<string, unknown> {
  const organizer = transcript.meetingOrganizer as { user?: { displayName?: string; id?: string } } | undefined;
  return {
    id: transcript.id,
    meeting_id: transcript.meetingId,
    created_at: transcript.createdDateTime,
    end_at: transcript.endDateTime,
    content_correlation_id: transcript.contentCorrelationId,
    organizer_name: organizer?.user?.displayName,
    organizer_id: organizer?.user?.id,
  };
}

// ── Chat API calls ──────────────────────────────────────────────────────────

export async function listChats(
  top: number,
  chatType?: string,
  expandMembers?: boolean,
): Promise<{ chats: Record<string, unknown>[]; count: number }> {
  let req = getGraph()
    .api('/me/chats')
    .select('id,topic,chatType,createdDateTime,lastUpdatedDateTime,onlineMeetingInfo,lastMessagePreview,tenantId,webUrl')
    .top(top)
    .orderby('lastMessagePreview/createdDateTime desc');

  if (chatType) {
    req = req.filter(`chatType eq '${escapeODataString(chatType)}'`);
  }
  if (expandMembers) {
    req = req.expand('members');
  }

  const response = await req.get();
  const chats = (response as { value?: Array<Record<string, unknown>> }).value ?? [];
  return { chats, count: chats.length };
}

export async function getChat(chatId: string): Promise<Record<string, unknown>> {
  return await getGraph()
    .api(`/me/chats/${encodeURIComponent(chatId)}`)
    .select('id,topic,chatType,createdDateTime,lastUpdatedDateTime,onlineMeetingInfo,tenantId,webUrl')
    .expand('members')
    .get();
}

export async function listChatMessages(chatId: string, top: number): Promise<{ messages: Record<string, unknown>[]; count: number }> {
  const response = await getGraph()
    .api(`/me/chats/${encodeURIComponent(chatId)}/messages`)
    .top(top)
    .get();
  const messages = (response as { value?: Array<Record<string, unknown>> }).value ?? [];
  return { messages, count: messages.length };
}

export async function getChatMessage(chatId: string, messageId: string): Promise<Record<string, unknown>> {
  return await getGraph()
    .api(`/me/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`)
    .get();
}

export async function sendChatMessage(chatId: string, content: string): Promise<Record<string, unknown>> {
  return await getGraph()
    .api(`/chats/${encodeURIComponent(chatId)}/messages`)
    .post({ body: { content } });
}

// ── Meeting API calls ───────────────────────────────────────────────────────

export async function resolveMeeting(joinWebUrl: string): Promise<Record<string, unknown> | null> {
  // The /me/onlineMeetings endpoint does NOT support $select — it returns
  // "Query option 'Select' is not allowed" if the SDK adds one.  Using a raw
  // fetch with only $filter (the one supported query option) avoids the issue.
  const token = await getAccessToken();
  const filter = `JoinWebUrl eq '${escapeODataString(joinWebUrl)}'`;
  const endpoint = `https://graph.microsoft.com/v1.0/me/onlineMeetings?$filter=${encodeURIComponent(filter)}`;
  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`UPSTREAM_ERROR: resolve meeting failed (${res.status}) ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { value?: Array<Record<string, unknown>> };
  return data.value?.[0] ?? null;
}

export async function listMeetingTranscripts(meetingId: string): Promise<{ transcripts: Record<string, unknown>[]; count: number }> {
  const response = await getGraph()
    .api(`/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`)
    .get();
  const transcripts = (response as { value?: Array<Record<string, unknown>> }).value ?? [];
  return { transcripts, count: transcripts.length };
}

export async function getMeetingTranscript(meetingId: string, transcriptId: string): Promise<Record<string, unknown>> {
  return await getGraph()
    .api(`/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}`)
    .get();
}

export async function getTranscriptContent(meetingId: string, transcriptId: string): Promise<string> {
  const token = await getAccessToken();
  const endpoint = `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/vtt',
    },
  });
  if (!response.ok) {
    throw new Error(`UPSTREAM_ERROR: transcript content fetch failed (${response.status})`);
  }
  return await response.text();
}
