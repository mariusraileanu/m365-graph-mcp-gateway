import { getGraph } from '../auth/index.js';
import { compactText, stripHtml, escapeODataString } from '../utils/helpers.js';
import { loadConfig } from '../config/index.js';
import { graphFetch } from './http.js';
import type { GraphCollectionResponse } from './types.js';

type GraphMeetingInfo = {
  joinWebUrl?: string;
  calendarEventId?: string;
};

type GraphLastMessagePreview = {
  body?: {
    content?: string;
  };
  createdDateTime?: string;
};

type GraphChat = {
  id?: string;
  topic?: string;
  chatType?: string;
  createdDateTime?: string;
  lastUpdatedDateTime?: string;
  onlineMeetingInfo?: GraphMeetingInfo;
  lastMessagePreview?: GraphLastMessagePreview;
  tenantId?: string;
  webUrl?: string;
  members?: Array<{ displayName?: string; id?: string }>;
};

type GraphMessageUser = {
  displayName?: string;
  id?: string;
};

type GraphMessageFrom = {
  user?: GraphMessageUser;
};

type GraphMessageBody = {
  contentType?: string;
  content?: string;
};

type GraphChatMessage = {
  id?: string;
  messageType?: string;
  from?: GraphMessageFrom;
  body?: GraphMessageBody;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  importance?: string;
  webUrl?: string;
  attachments?: Array<Record<string, unknown>>;
};

type GraphMeetingOrganizer = {
  user?: GraphMessageUser;
};

type GraphTranscript = {
  id?: string;
  meetingId?: string;
  createdDateTime?: string;
  endDateTime?: string;
  contentCorrelationId?: string;
  meetingOrganizer?: GraphMeetingOrganizer;
};

type GraphOnlineMeeting = {
  id?: string;
  subject?: string;
  startDateTime?: string;
  endDateTime?: string;
  joinWebUrl?: string;
  chatInfo?: { threadId?: string; messageId?: string };
};

// ── Picker functions ────────────────────────────────────────────────────────

export function pickChat(chat: GraphChat, includeFullPayload: boolean): Record<string, unknown> {
  const meetingInfo = chat.onlineMeetingInfo;
  const lastPreview = chat.lastMessagePreview;
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

export function pickMessage(message: GraphChatMessage, includeFullPayload: boolean): Record<string, unknown> {
  const from = message.from;
  const body = message.body;
  const bodyContent = body?.content ?? '';
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

export function pickTranscript(transcript: GraphTranscript): Record<string, unknown> {
  const organizer = transcript.meetingOrganizer;
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
): Promise<{ chats: GraphChat[]; count: number }> {
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
  const chats = (response as GraphCollectionResponse<GraphChat>).value ?? [];
  return { chats, count: chats.length };
}

export async function getChat(chatId: string): Promise<GraphChat> {
  return (await getGraph()
    .api(`/me/chats/${encodeURIComponent(chatId)}`)
    .select('id,topic,chatType,createdDateTime,lastUpdatedDateTime,onlineMeetingInfo,tenantId,webUrl')
    .expand('members')
    .get()) as GraphChat;
}

export async function listChatMessages(chatId: string, top: number): Promise<{ messages: GraphChatMessage[]; count: number }> {
  const response = await getGraph()
    .api(`/me/chats/${encodeURIComponent(chatId)}/messages`)
    .top(top)
    .get();
  const messages = (response as GraphCollectionResponse<GraphChatMessage>).value ?? [];
  return { messages, count: messages.length };
}

export async function getChatMessage(chatId: string, messageId: string): Promise<GraphChatMessage> {
  return (await getGraph()
    .api(`/me/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`)
    .get()) as GraphChatMessage;
}

export async function sendChatMessage(chatId: string, content: string): Promise<GraphChatMessage> {
  return (await getGraph()
    .api(`/chats/${encodeURIComponent(chatId)}/messages`)
    .post({ body: { content } })) as GraphChatMessage;
}

// ── Meeting API calls ───────────────────────────────────────────────────────

export async function resolveMeeting(joinWebUrl: string): Promise<GraphOnlineMeeting | null> {
  // The /me/onlineMeetings endpoint does NOT support $select — it returns
  // "Query option 'Select' is not allowed" if the SDK adds one.  Using a raw
  // fetch with only $filter (the one supported query option) avoids the issue.
  const filter = `JoinWebUrl eq '${escapeODataString(joinWebUrl)}'`;
  const endpoint = `https://graph.microsoft.com/v1.0/me/onlineMeetings?$filter=${encodeURIComponent(filter)}`;
  const res = await graphFetch(endpoint, 'UPSTREAM_ERROR: resolve meeting failed');
  const data = (await res.json()) as GraphCollectionResponse<GraphOnlineMeeting>;
  return data.value?.[0] ?? null;
}

export async function listMeetingTranscripts(meetingId: string): Promise<{ transcripts: GraphTranscript[]; count: number }> {
  const response = await getGraph()
    .api(`/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`)
    .get();
  const transcripts = (response as GraphCollectionResponse<GraphTranscript>).value ?? [];
  return { transcripts, count: transcripts.length };
}

export async function getMeetingTranscript(meetingId: string, transcriptId: string): Promise<GraphTranscript> {
  return (await getGraph()
    .api(`/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}`)
    .get()) as GraphTranscript;
}

export async function getTranscriptContent(meetingId: string, transcriptId: string): Promise<string> {
  const endpoint = `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`;
  const response = await graphFetch(endpoint, 'UPSTREAM_ERROR: transcript content fetch failed', {
    headers: { Accept: 'text/vtt' },
  });
  return await response.text();
}
