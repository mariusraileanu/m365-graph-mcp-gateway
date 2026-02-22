import { getGraph } from '../auth/index.js';
import { loadConfig } from '../config/index.js';

/** Map common IANA timezone identifiers to Windows timezone names used by Microsoft Graph. */
const IANA_TO_WINDOWS: Record<string, string> = {
  'Pacific/Honolulu': 'Hawaiian Standard Time',
  'America/Anchorage': 'Alaskan Standard Time',
  'America/Los_Angeles': 'Pacific Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/New_York': 'Eastern Standard Time',
  'America/Sao_Paulo': 'E. South America Standard Time',
  'Atlantic/Reykjavik': 'Greenwich Standard Time',
  'Europe/London': 'GMT Standard Time',
  'Europe/Paris': 'Romance Standard Time',
  'Europe/Berlin': 'W. Europe Standard Time',
  'Europe/Helsinki': 'FLE Standard Time',
  'Europe/Moscow': 'Russian Standard Time',
  'Europe/Istanbul': 'Turkey Standard Time',
  'Asia/Dubai': 'Arabian Standard Time',
  'Asia/Karachi': 'Pakistan Standard Time',
  'Asia/Kolkata': 'India Standard Time',
  'Asia/Dhaka': 'Bangladesh Standard Time',
  'Asia/Bangkok': 'SE Asia Standard Time',
  'Asia/Shanghai': 'China Standard Time',
  'Asia/Tokyo': 'Tokyo Standard Time',
  'Australia/Sydney': 'AUS Eastern Standard Time',
  'Pacific/Auckland': 'New Zealand Standard Time',
  UTC: 'UTC',
};

/**
 * Standard UTC offset in minutes for each IANA timezone.
 * Used to convert "naive" local datetimes to UTC for the CalendarView API,
 * which always interprets startDateTime/endDateTime as UTC.
 * Note: these are standard (non-DST) offsets. Zones that observe DST
 * (e.g. America/New_York) will be off by 1 hour during DST.
 */
const IANA_OFFSET_MINUTES: Record<string, number> = {
  'Pacific/Honolulu': -600,
  'America/Anchorage': -540,
  'America/Los_Angeles': -480,
  'America/Denver': -420,
  'America/Chicago': -360,
  'America/New_York': -300,
  'America/Sao_Paulo': -180,
  'Atlantic/Reykjavik': 0,
  'Europe/London': 0,
  'Europe/Paris': 60,
  'Europe/Berlin': 60,
  'Europe/Helsinki': 120,
  'Europe/Moscow': 180,
  'Europe/Istanbul': 180,
  'Asia/Dubai': 240,
  'Asia/Karachi': 300,
  'Asia/Kolkata': 330,
  'Asia/Dhaka': 360,
  'Asia/Bangkok': 420,
  'Asia/Shanghai': 480,
  'Asia/Tokyo': 540,
  'Australia/Sydney': 660,
  'Pacific/Auckland': 720,
  UTC: 0,
};

/** Resolve a timezone string to a Windows timezone name for the Graph API Prefer header. */
export function resolveTimezone(tz?: string): string {
  const timezone = tz?.trim() || loadConfig().calendar.defaultTimezone;
  return IANA_TO_WINDOWS[timezone] || timezone;
}

/**
 * Convert a "naive" local datetime string (no offset) to a UTC ISO string.
 * The CalendarView API always interprets startDateTime/endDateTime as UTC,
 * so we subtract the local timezone offset to get the correct UTC boundary.
 *
 * If the datetime already contains an offset ('+', 'Z'), it is returned as-is.
 */
export function localToUtc(datetime: string, tz?: string): string {
  // If it already has timezone info, return as-is
  if (/[Zz+]/.test(datetime) || /\d-\d{2}:\d{2}$/.test(datetime)) return datetime;
  const timezone = tz?.trim() || loadConfig().calendar.defaultTimezone;
  const offsetMinutes = IANA_OFFSET_MINUTES[timezone];
  if (offsetMinutes === undefined || offsetMinutes === 0) return datetime;
  const local = new Date(datetime);
  if (isNaN(local.getTime())) return datetime;
  const utc = new Date(local.getTime() - offsetMinutes * 60_000);
  return utc.toISOString().replace('Z', '');
}

interface AttendeeEmail {
  address?: string;
  name?: string;
}

interface Attendee {
  emailAddress?: AttendeeEmail;
  type?: string;
  status?: { response?: string; time?: string };
}

function pickAttendees(raw: unknown[]): Array<Record<string, unknown>> {
  return raw.map((att) => {
    const a = att as Attendee;
    return {
      name: a.emailAddress?.name,
      email: a.emailAddress?.address,
      type: a.type,
      response: a.status?.response,
    };
  });
}

export function pickEvent(event: Record<string, unknown>, includeFullPayload: boolean): Record<string, unknown> {
  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  const isOnline = event.isOnlineMeeting === true || Boolean(event.onlineMeeting);
  const minimal = {
    id: event.id,
    subject: event.subject,
    start: (event.start as { dateTime?: string; timeZone?: string } | undefined)?.dateTime,
    end: (event.end as { dateTime?: string; timeZone?: string } | undefined)?.dateTime,
    organizer: (event.organizer as { emailAddress?: { address?: string; name?: string } } | undefined)?.emailAddress,
    attendee_count: attendees.length,
    location: (event.location as { displayName?: string } | undefined)?.displayName,
    is_online_meeting: isOnline,
    web_link: event.webLink,
    teams_join_url: (event.onlineMeeting as { joinUrl?: string } | undefined)?.joinUrl,
  };
  if (!includeFullPayload) return minimal;
  return {
    ...minimal,
    attendees: pickAttendees(attendees),
    response_status: event.responseStatus,
    online_meeting: event.onlineMeeting,
    web_link: event.webLink,
    body_preview: event.bodyPreview,
  };
}

const CALENDAR_VIEW_SELECT = [
  'id',
  'subject',
  'start',
  'end',
  'location',
  'organizer',
  'attendees',
  'isOnlineMeeting',
  'onlineMeeting',
  'webLink',
  'bodyPreview',
].join(',');

/** Fetch events in a date range using the CalendarView API (expands recurring events).
 *
 * The Graph CalendarView API always interprets startDateTime/endDateTime as UTC.
 * If the caller passes naive (no-offset) local datetimes, we convert them to UTC
 * using the configured timezone offset so the query covers the correct local day.
 * The Prefer header still requests event times in the local timezone for display.
 */
export async function calendarView(
  startDateTime: string,
  endDateTime: string,
  top: number,
  timezone?: string,
): Promise<Record<string, unknown>[]> {
  const windowsTz = resolveTimezone(timezone);
  const utcStart = localToUtc(startDateTime, timezone);
  const utcEnd = localToUtc(endDateTime, timezone);
  const response = await getGraph()
    .api('/me/calendarView')
    .header('Prefer', `outlook.timezone="${windowsTz}"`)
    .query({ startDateTime: utcStart, endDateTime: utcEnd })
    .select(CALENDAR_VIEW_SELECT)
    .top(top)
    .orderby('start/dateTime')
    .get();
  const events = (response as { value?: Array<Record<string, unknown>> }).value ?? [];
  return events.map((e) => pickEvent(e, true));
}
