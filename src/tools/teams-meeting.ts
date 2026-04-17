import { z } from 'zod';
import { isLoggedIn } from '../auth/index.js';
import { ok, fail } from '../utils/helpers.js';
import { graphCache } from '../utils/cache.js';
import { resolveMeeting, listMeetingTranscripts, getMeetingTranscript, getTranscriptContent, pickTranscript, listChats, pickChat } from '../graph/teams.js';
import type { ToolSpec } from '../utils/types.js';

const CACHE_TTL_MS = 30_000;

/** Map Graph error status codes / messages to structured unavailability reasons. */
function transcriptUnavailableReason(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('404') || message.includes('not found')) return 'transcription_not_enabled';
  if (message.includes('403') || message.includes('Forbidden')) return 'no_permission';
  if (message.includes('410') || message.includes('Gone')) return 'meeting_expired';
  return null;
}

function newestTranscript(transcripts: Record<string, unknown>[]): Record<string, unknown> | null {
  return [...transcripts].sort((a, b) => {
    const aTime = Date.parse(String(a.createdDateTime ?? ''));
    const bTime = Date.parse(String(b.createdDateTime ?? ''));
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  })[0] ?? null;
}

async function pickLatestTranscriptId(meetingId: string): Promise<Record<string, unknown> | null> {
  const listed = await listMeetingTranscripts(meetingId);
  return newestTranscript(listed.transcripts);
}

function normalizedTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function meetingTitleMatches(topic: unknown, query: string): boolean {
  const topicTokens = normalizedTokens(String(topic ?? ''));
  const queryTokens = normalizedTokens(query);
  if (topicTokens.length === 0 || queryTokens.length === 0) return false;
  const topicText = ` ${topicTokens.join(' ')} `;
  const queryText = ` ${queryTokens.join(' ')} `;
  return topicText.includes(queryText) || queryTokens.every((token) => topicTokens.includes(token));
}

async function resolveMeetingFromQuery(query: string, top: number): Promise<{ meeting: Record<string, unknown> | null; chat?: Record<string, unknown>; errors: string[] }> {
  const listed = await listChats(top, 'meeting', false);
  const matches = listed.chats.filter((chat) => meetingTitleMatches(chat.topic, query));
  const errors: string[] = [];

  for (const chat of matches) {
    const joinWebUrl = (chat.onlineMeetingInfo as { joinWebUrl?: string } | undefined)?.joinWebUrl;
    if (!joinWebUrl) continue;
    try {
      const meeting = await resolveMeeting(joinWebUrl);
      if (meeting) return { meeting, chat, errors };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { meeting: null, chat: matches[0], errors };
}

async function transcriptContentForMeeting(meetingId: string, maxChars?: number): Promise<Record<string, unknown>> {
  const transcript = await pickLatestTranscriptId(meetingId);
  const transcriptId = typeof transcript?.id === 'string' ? transcript.id : '';
  if (!transcriptId) {
    return {
      available: false,
      reason: 'no_transcripts',
      meeting_id: meetingId,
    };
  }

  const vttContent = await getTranscriptContent(meetingId, transcriptId);
  const limit = maxChars ?? vttContent.length;
  const safeLimit = Math.max(200, Math.min(limit, 50_000));
  const normalized = vttContent.replace(/\r\n/g, '\n').trim();
  const content = normalized.slice(0, safeLimit);
  return {
    available: true,
    meeting_id: meetingId,
    transcript_id: transcriptId,
    transcript: pickTranscript(transcript as Record<string, unknown>),
    format: 'text/vtt',
    content,
    truncated: normalized.length > content.length,
    content_length: normalized.length,
  };
}

export const teamsMeetingTools: ToolSpec[] = [
  {
    name: 'resolve_meeting',
    description:
      'Resolve a Teams meeting joinWebUrl to a meeting ID. Best-effort — may fail if the meeting ' +
      'was not created with a calendar association or has expired. Use the joinWebUrl from get_chat ' +
      'on a meeting chat (chatType=meeting).',
    schema: z
      .object({
        join_web_url: z.string().url(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const joinWebUrl = String(params.join_web_url);

      const cacheKey = `meeting:${joinWebUrl}`;
      const cached = graphCache.get(cacheKey) as Record<string, unknown> | null | undefined;
      const meeting = cached !== undefined ? cached : await resolveMeeting(joinWebUrl);
      if (cached === undefined) graphCache.set(cacheKey, meeting as Record<string, unknown> | null, CACHE_TTL_MS);

      if (!meeting) {
        return fail(
          'MEETING_NOT_RESOLVABLE',
          'No meeting found for the provided joinWebUrl. The meeting may have expired or was created without calendar association.',
          {
            join_web_url: joinWebUrl,
          },
        );
      }

      return ok('Meeting resolved.', {
        meeting_id: meeting.id,
        subject: meeting.subject,
        start_at: meeting.startDateTime,
        end_at: meeting.endDateTime,
        join_web_url: meeting.joinWebUrl,
        chat_info: meeting.chatInfo,
      });
    },
  },
  {
    name: 'list_meeting_transcripts',
    description:
      'List transcripts for a Teams meeting. Returns transcript metadata (not content). ' +
      'If transcription was not enabled or the meeting expired, returns available=false with a reason ' +
      'instead of throwing an error.',
    schema: z
      .object({
        meeting_id: z.string().min(1),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const meetingId = String(params.meeting_id);

      const cacheKey = `transcripts:${meetingId}`;
      const cached = graphCache.get(cacheKey) as { transcripts: Record<string, unknown>[]; count: number } | undefined;

      let result: { transcripts: Record<string, unknown>[]; count: number };
      try {
        result = cached ?? (await listMeetingTranscripts(meetingId));
        if (!cached) graphCache.set(cacheKey, result, CACHE_TTL_MS);
      } catch (err) {
        const reason = transcriptUnavailableReason(err);
        if (reason) {
          return ok('Transcripts not available.', {
            available: false,
            reason,
            meeting_id: meetingId,
          });
        }
        throw err;
      }

      const transcripts = result.transcripts.map((t) => pickTranscript(t));
      return ok(`${transcripts.length} transcript(s) found.`, {
        available: true,
        count: transcripts.length,
        meeting_id: meetingId,
        transcripts,
      });
    },
  },
  {
    name: 'get_meeting_transcript',
    description:
      'Get metadata for a specific meeting transcript. Returns transcript details without content. ' +
      'Use get_transcript_content to retrieve the actual WebVTT content.',
    schema: z
      .object({
        meeting_id: z.string().min(1),
        transcript_id: z.string().min(1),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const meetingId = String(params.meeting_id);
      const transcriptId = String(params.transcript_id);

      const cacheKey = `transcript:${meetingId}:${transcriptId}`;
      const cached = graphCache.get(cacheKey) as Record<string, unknown> | undefined;

      let transcript: Record<string, unknown>;
      try {
        transcript = cached ?? (await getMeetingTranscript(meetingId, transcriptId));
        if (!cached) graphCache.set(cacheKey, transcript, CACHE_TTL_MS);
      } catch (err) {
        const reason = transcriptUnavailableReason(err);
        if (reason) {
          return ok('Transcript not available.', {
            available: false,
            reason,
            meeting_id: meetingId,
            transcript_id: transcriptId,
          });
        }
        throw err;
      }

      return ok('Transcript metadata retrieved.', pickTranscript(transcript));
    },
  },
  {
    name: 'get_latest_meeting_transcript',
    description:
      'One-step helper for transcript workflows. Given a meeting title/query, Teams join URL, or meeting_id, ' +
      'finds the meeting, selects the newest transcript, and returns WebVTT content. Prefer this over chaining ' +
      'find events -> resolve_meeting -> list transcripts -> get_transcript_content.',
    schema: z
      .object({
        query: z.string().min(1).optional(),
        join_web_url: z.string().url().optional(),
        meeting_id: z.string().min(1).optional(),
        top: z.number().int().positive().max(50).optional(),
        max_chars: z.number().int().positive().max(50000).optional(),
      })
      .strict()
      .refine((p) => p.query || p.join_web_url || p.meeting_id, {
        message: 'query, join_web_url, or meeting_id is required',
      }),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const maxChars = typeof params.max_chars === 'number' ? params.max_chars : undefined;
      const top = typeof params.top === 'number' ? params.top : 50;
      let meeting: Record<string, unknown> | null = null;
      let matchedChat: Record<string, unknown> | undefined;
      const resolutionErrors: string[] = [];

      if (typeof params.meeting_id === 'string') {
        meeting = { id: params.meeting_id };
      } else if (typeof params.join_web_url === 'string') {
        meeting = await resolveMeeting(params.join_web_url);
      } else if (typeof params.query === 'string') {
        const resolved = await resolveMeetingFromQuery(params.query, top);
        meeting = resolved.meeting;
        matchedChat = resolved.chat;
        resolutionErrors.push(...resolved.errors);
      }

      const meetingId = typeof meeting?.id === 'string' ? meeting.id : '';
      if (!meetingId) {
        return fail('MEETING_NOT_RESOLVABLE', 'Could not resolve a Teams meeting from the provided input.', {
          ...(params.query ? { query: params.query } : {}),
          ...(params.join_web_url ? { join_web_url: params.join_web_url } : {}),
          ...(matchedChat ? { matched_chat: pickChat(matchedChat, false) } : {}),
          ...(resolutionErrors.length > 0 ? { resolution_errors: resolutionErrors.slice(0, 3) } : {}),
        });
      }

      const transcript = await transcriptContentForMeeting(meetingId, maxChars);
      const resolvedMeeting = meeting as Record<string, unknown>;
      return ok('Latest transcript content retrieved.', {
        ...transcript,
        meeting: {
          id: meetingId,
          subject: resolvedMeeting.subject,
          start_at: resolvedMeeting.startDateTime,
          end_at: resolvedMeeting.endDateTime,
          join_web_url: resolvedMeeting.joinWebUrl,
        },
        ...(matchedChat ? { matched_chat: pickChat(matchedChat, false) } : {}),
      });
    },
  },
  {
    name: 'get_transcript_content',
    description:
      'Get the WebVTT content of a meeting transcript. If transcript_id is omitted, uses the newest ' +
      'transcript for the meeting. Returns plain text with timestamps and ' +
      'speaker tags (<v Speaker>). If the transcript is not available, returns available=false ' +
      'with a reason instead of throwing.',
    schema: z
      .object({
        meeting_id: z.string().min(1),
        transcript_id: z.string().min(1).optional(),
        max_chars: z.number().int().positive().max(50000).optional(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const meetingId = String(params.meeting_id);
      let transcriptId = typeof params.transcript_id === 'string' ? params.transcript_id.trim() : '';
      const maxChars = typeof params.max_chars === 'number' ? params.max_chars : undefined;
      let selectedTranscript: Record<string, unknown> | null = null;
      let usedFallbackLatest = false;

      if (!transcriptId) {
        selectedTranscript = await pickLatestTranscriptId(meetingId);
        transcriptId = typeof selectedTranscript?.id === 'string' ? selectedTranscript.id : '';
        usedFallbackLatest = true;
        if (!transcriptId) {
          return ok('Transcript content not available.', {
            available: false,
            reason: 'no_transcripts',
            meeting_id: meetingId,
          });
        }
      }

      let vttContent: string;
      try {
        vttContent = await getTranscriptContent(meetingId, transcriptId);
      } catch (err) {
        const reason = transcriptUnavailableReason(err);
        if (reason) {
          return ok('Transcript content not available.', {
            available: false,
            reason,
            meeting_id: meetingId,
            transcript_id: transcriptId,
          });
        }
        if (!/Invalid transcript id/i.test(err instanceof Error ? err.message : String(err))) {
          throw err;
        }
        selectedTranscript = await pickLatestTranscriptId(meetingId);
        const fallbackId = typeof selectedTranscript?.id === 'string' ? selectedTranscript.id : '';
        if (!fallbackId || fallbackId === transcriptId) throw err;
        vttContent = await getTranscriptContent(meetingId, fallbackId);
        transcriptId = fallbackId;
        usedFallbackLatest = true;
      }

      // Transcripts are primary content — bypass the global hardMaxChars cap.
      // The schema already limits max_chars to 50 000; default to full content.
      const limit = maxChars ?? vttContent.length;
      const safeLimit = Math.max(200, Math.min(limit, 50_000));
      const normalized = vttContent.replace(/\r\n/g, '\n').trim();
      const content = normalized.slice(0, safeLimit);
      return ok('Transcript content retrieved.', {
        available: true,
        meeting_id: meetingId,
        transcript_id: transcriptId,
        transcript: selectedTranscript ? pickTranscript(selectedTranscript) : undefined,
        used_fallback_latest: usedFallbackLatest,
        format: 'text/vtt',
        content,
        truncated: normalized.length > content.length,
        content_length: normalized.length,
      });
    },
  },
];
