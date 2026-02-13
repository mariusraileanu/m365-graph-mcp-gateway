#!/usr/bin/env bash
set -euo pipefail

JOBS_FILE="${1:-./data/.openclaw/cron/jobs.json}"

mkdir -p "$(dirname "$JOBS_FILE")"
if [[ ! -f "$JOBS_FILE" ]]; then
  cat > "$JOBS_FILE" <<'EOF'
{
  "version": 1,
  "jobs": []
}
EOF
fi

JOBS_FILE_ABS="$(cd "$(dirname "$JOBS_FILE")" && pwd)/$(basename "$JOBS_FILE")"

JOBS_FILE="$JOBS_FILE_ABS" node <<'EOF'
const fs = require("fs");

const jobsPath = process.env.JOBS_FILE;
const raw = fs.readFileSync(jobsPath, "utf8");
const doc = JSON.parse(raw);

if (!Array.isArray(doc.jobs)) {
  doc.jobs = [];
}

const now = Date.now();
const jobId = "7025fca3-12a3-42e2-b586-38fadc60b764";

const message = `You are Jarvis preparing the daily 08:00 briefing.
You are executing the "Morning Brief" task using OpenClaw.

Audience: Marius.
Time zone: Asia/Dubai (GMT+4). Render ALL times in GMT+4.
Date anchor: "today" in Asia/Dubai.

Goal:
Send one high-signal morning briefing message to Telegram in this exact section order:
1) WHOOP
2) Today
3) Email
4) News
5) Top Actions

Execution rules:
- Use ONLY these tools for this task: exec, message.
- Do NOT call: cron, session_status, memory_search, memory_get, sessions_*, gateway.
- Collect data with exec commands (in this order):
  1. /home/node/.openclaw/workspace-cron/bin/oc_whoop_today_json
  2. /home/node/.openclaw/workspace-cron/bin/oc_calendar_today_json
  3. /home/node/.openclaw/workspace-cron/bin/oc_email_unread_json
  4. /home/node/.openclaw/workspace-cron/bin/oc_weather_abu_dhabi_json
  5. /home/node/.openclaw/workspace-cron/bin/oc_news_ai_health_json
- Each command returns a JSON envelope:
  - ok (bool), source, exit_code, timed_out, stdout, stderr, data (parsed JSON when available).
- Treat a source as failed if ok=false. Use stdout as canonical payload when ok=true and data is null.

Adaptive send logic:
- Always send exactly one Telegram message per run.
- Never return NO_SEND.
- If there are no actionable items, send a short "all clear" summary.
- If any core source fails (calendar/email/whoop/weather/news), send a brief fallback message that states which source failed and what is still available.

Formatting requirements for telegramMessage:
- Plain Telegram text only.
- Mandatory section spacing:
  - Header line
  - One empty line
  - Content lines
  - One empty line
- Do not collapse blank lines.
- Use this header order exactly:
  - "💪 WHOOP"
  - "📅 Today"
  - "📧 Email"
  - "🗞️ News"
  - "🔔 Top Actions"

Content requirements:
- WHOOP:
  - Show recovery, HRV, RHR, SpO2, skin temp.
  - Show sleep start/end, total sleep, light/deep/REM, efficiency, disturbances.
  - Show strain, calories, avg/max HR.
  - Add readiness interpretation and one recommendation.
- Today:
  - Source meetings ONLY from oc_calendar_today_json.stdout output.
  - Include ALL meetings in the same order and keep titles faithful.
  - Include weather line.
  - Add move-suggestion lines only if conflict/overload exists.
  - If conflict is high-impact or ambiguous, add:
    "Approval needed: Should I suggest rescheduling <meeting>?"
- Email:
  - Show top 3-5 items with action tags:
    [Reply needed], [Delegation], [Awaiting reply], [FYI]
  - Include why it matters.
- News:
  - Top 3 only, each with source and direct URL from tool output.
  - Never output placeholder/fake links.
- Top Actions:
  - Output top 3 actions for today, prioritized, each one line.

Delivery rules:
- You MUST call message tool exactly once:
  - channel: telegram
  - target: 8372003460
  - text: telegramMessage
- Do NOT send confirmation/follow-up messages.
- Do NOT send any second message.

Output contract:
- Return ONLY valid JSON:
{
  "telegramChannel": "telegram_send",
  "telegramMessage": "<formatted message>"
}
- telegramMessage must equal the exact sent message body you sent via message tool.
- After calling message tool, the final assistant output MUST be only the JSON object above.
- Never output confirmation phrases like "sent", "delivered", or "successfully sent".
- No markdown fences, no meta commentary.`;

const existingIdx = doc.jobs.findIndex((j) => j && j.id === jobId);
const previous = existingIdx >= 0 ? doc.jobs[existingIdx] : null;
const createdAtMs = previous?.createdAtMs ?? now;

const job = {
  id: jobId,
  name: "Morning Brief 08:00",
  description: "Daily 08:00 GMT+4 briefing with WHOOP-first summary, calendar optimization, emails, weather, and news.",
  enabled: true,
  createdAtMs,
  updatedAtMs: now,
  schedule: {
    kind: "cron",
    expr: "0 8 * * *",
    tz: "Asia/Dubai",
  },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: {
    kind: "agentTurn",
    message,
    model: "compass/gpt-4o",
  },
  delivery: {
    mode: "none",
    channel: "last",
  },
  state: previous?.state ?? {},
  agentId: "cron",
};

if (existingIdx >= 0) {
  doc.jobs[existingIdx] = { ...previous, ...job };
} else {
  doc.jobs.push(job);
}

fs.writeFileSync(jobsPath, JSON.stringify(doc, null, 2) + "\n");
EOF

echo "Morning briefing cron job synced in: ${JOBS_FILE}"
