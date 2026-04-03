import { z } from 'zod';
import { isLoggedIn } from '../auth/index.js';
import { ok, fail, compactText } from '../utils/helpers.js';
import { graphCache } from '../utils/cache.js';
import { resolveMeeting, listMeetingTranscripts, getMeetingTranscript, getTranscriptContent, pickTranscript } from '../graph/teams.js';
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
    name: 'get_transcript_content',
    description:
      'Get the WebVTT content of a meeting transcript. Returns plain text with timestamps and ' +
      'speaker tags (<v Speaker>). If the transcript is not available, returns available=false ' +
      'with a reason instead of throwing.',
    schema: z
      .object({
        meeting_id: z.string().min(1),
        transcript_id: z.string().min(1),
        max_chars: z.number().int().positive().max(50000).optional(),
      })
      .strict(),
    run: async (params) => {
      if (!(await isLoggedIn())) throw new Error('AUTH_REQUIRED: not logged in');
      const meetingId = String(params.meeting_id);
      const transcriptId = String(params.transcript_id);
      const maxChars = typeof params.max_chars === 'number' ? params.max_chars : undefined;

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
        throw err;
      }

      const compact = compactText(vttContent, maxChars);
      return ok('Transcript content retrieved.', {
        available: true,
        meeting_id: meetingId,
        transcript_id: transcriptId,
        format: 'text/vtt',
        content: compact.text,
        truncated: compact.truncated,
        content_length: vttContent.length,
      });
    },
  },
];
