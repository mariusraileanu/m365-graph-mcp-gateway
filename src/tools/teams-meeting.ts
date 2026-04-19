import { z } from 'zod';
import { resolveMeeting, listMeetingTranscripts, getMeetingTranscript, getTranscriptContent, pickTranscript } from '../graph/teams.js';
import { ok, fail } from './results.js';
import { requireLoggedIn, readThroughGraphCache, GRAPH_CACHE_TTL_MS } from './shared.js';
import { defineTool } from './types.js';
import type { ToolSpec, ToolSuccess } from './types.js';

type GraphHttpErrorLike = {
  statusCode?: unknown;
  status?: unknown;
  code?: unknown;
};

function transcriptUnavailableReason(err: unknown): string | null {
  const details = err as GraphHttpErrorLike | undefined;
  const status = typeof details?.statusCode === 'number' ? details.statusCode : typeof details?.status === 'number' ? details.status : undefined;
  const code = typeof details?.code === 'string' ? details.code : undefined;
  if (status === 404 || code === 'NotFound') return 'transcription_not_enabled';
  if (status === 403 || code === 'Forbidden') return 'no_permission';
  if (status === 410 || code === 'Gone') return 'meeting_expired';
  return null;
}

async function withTranscriptAvailability<T>(message: string, details: Record<string, string>, loader: () => Promise<T>) {
  try {
    return await loader();
  } catch (err) {
    const reason = transcriptUnavailableReason(err);
    if (reason) {
      return ok(message, { available: false, reason, ...details });
    }
    throw err;
  }
}

function isToolSuccess(value: unknown): value is ToolSuccess {
  return typeof value === 'object' && value !== null && 'structuredContent' in value && 'content' in value;
}

export const teamsMeetingTools: ToolSpec[] = [
  defineTool({
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
      await requireLoggedIn();
      const joinWebUrl = params.join_web_url;

      const cacheKey = `meeting:${joinWebUrl}`;
      const meeting = await readThroughGraphCache(cacheKey, GRAPH_CACHE_TTL_MS, () => resolveMeeting(joinWebUrl));

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
  }),
  defineTool({
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
      await requireLoggedIn();
      const meetingId = params.meeting_id;

      const cacheKey = `transcripts:${meetingId}`;
      const unavailable = await withTranscriptAvailability('Transcripts not available.', { meeting_id: meetingId }, () =>
        readThroughGraphCache(cacheKey, GRAPH_CACHE_TTL_MS, () => listMeetingTranscripts(meetingId)),
      );
      if (isToolSuccess(unavailable)) return unavailable;

      const result = unavailable;

      const transcripts = result.transcripts.map((t) => pickTranscript(t));
      return ok(`${transcripts.length} transcript(s) found.`, {
        available: true,
        count: transcripts.length,
        meeting_id: meetingId,
        transcripts,
      });
    },
  }),
  defineTool({
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
      await requireLoggedIn();
      const meetingId = params.meeting_id;
      const transcriptId = params.transcript_id;

      const cacheKey = `transcript:${meetingId}:${transcriptId}`;
      const unavailable = await withTranscriptAvailability('Transcript not available.', { meeting_id: meetingId, transcript_id: transcriptId }, () =>
        readThroughGraphCache(cacheKey, GRAPH_CACHE_TTL_MS, () => getMeetingTranscript(meetingId, transcriptId)),
      );
      if (isToolSuccess(unavailable)) return unavailable;

      const transcript = unavailable;

      return ok('Transcript metadata retrieved.', pickTranscript(transcript));
    },
  }),
  defineTool({
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
      await requireLoggedIn();
      const meetingId = params.meeting_id;
      const transcriptId = params.transcript_id;
      const maxChars = params.max_chars;

      const unavailable = await withTranscriptAvailability('Transcript content not available.', { meeting_id: meetingId, transcript_id: transcriptId }, () =>
        getTranscriptContent(meetingId, transcriptId),
      );
      if (isToolSuccess(unavailable)) return unavailable;

      const vttContent = unavailable;

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
        format: 'text/vtt',
        content,
        truncated: normalized.length > content.length,
        content_length: normalized.length,
      });
    },
  }),
];
