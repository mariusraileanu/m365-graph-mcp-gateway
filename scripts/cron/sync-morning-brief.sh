#!/usr/bin/env bash
set -euo pipefail

JOBS_FILE="${1:-./data/.openclaw/cron/jobs.json}"
OWNER_NAME="${OPENCLAW_OWNER_NAME:-User}"
LOCAL_TZ="${OPENCLAW_LOCAL_TIMEZONE:-UTC}"
CITY="${OPENCLAW_CITY:-your city}"
TELEGRAM_TARGET="${OPENCLAW_TELEGRAM_TARGET_ID:-}"

if [[ -z "$TELEGRAM_TARGET" ]]; then
  echo "Error: OPENCLAW_TELEGRAM_TARGET_ID is required for morning brief cron delivery." >&2
  exit 1
fi

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

read -r -d '' MESSAGE_TEMPLATE <<'EOF' || true
You are Jarvis preparing the daily 08:00 briefing.
You are executing the "Morning Brief" task using OpenClaw.

Audience: __OWNER_NAME__.
Time zone: __LOCAL_TZ__. Render ALL times in __LOCAL_TZ__.
Date anchor: "today" in __LOCAL_TZ__.

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
  4. /home/node/.openclaw/workspace-cron/bin/oc_weather_local_json
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
  - Include weather line for __CITY__.
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
  - target: __TELEGRAM_TARGET__
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
- No markdown fences, no meta commentary.
EOF

MESSAGE="${MESSAGE_TEMPLATE//__OWNER_NAME__/$OWNER_NAME}"
MESSAGE="${MESSAGE//__LOCAL_TZ__/$LOCAL_TZ}"
MESSAGE="${MESSAGE//__CITY__/$CITY}"
MESSAGE="${MESSAGE//__TELEGRAM_TARGET__/$TELEGRAM_TARGET}"

JOBS_FILE="$JOBS_FILE_ABS" LOCAL_TZ="$LOCAL_TZ" MESSAGE="$MESSAGE" TELEGRAM_TARGET="$TELEGRAM_TARGET" python3 <<'PY'
import json
import os
import time

jobs_path = os.environ["JOBS_FILE"]
local_tz = os.environ.get("LOCAL_TZ", "UTC")
message = os.environ["MESSAGE"]
telegram_target = os.environ.get("TELEGRAM_TARGET", "")
job_id = "7025fca3-12a3-42e2-b586-38fadc60b764"

with open(jobs_path, "r", encoding="utf-8") as f:
    doc = json.load(f)

if not isinstance(doc.get("jobs"), list):
    doc["jobs"] = []

now = int(time.time() * 1000)
existing_idx = next((i for i, j in enumerate(doc["jobs"]) if isinstance(j, dict) and j.get("id") == job_id), -1)
previous = doc["jobs"][existing_idx] if existing_idx >= 0 else None
created_at_ms = previous.get("createdAtMs", now) if isinstance(previous, dict) else now

job = {
    "id": job_id,
    "name": "Morning Brief 08:00",
    "description": "Daily 08:00 briefing with WHOOP-first summary, calendar optimization, emails, weather, and news.",
    "enabled": True,
    "createdAtMs": created_at_ms,
    "updatedAtMs": now,
    "schedule": {
        "kind": "cron",
        "expr": "0 8 * * *",
        "tz": local_tz,
    },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "payload": {
        "kind": "agentTurn",
        "message": message,
        "model": "compass/gpt-4o",
    },
    "delivery": {
        "mode": "channel",
        "channel": "telegram",
        "target": telegram_target,
    },
    "state": previous.get("state", {}) if isinstance(previous, dict) else {},
    "agentId": "cron",
}

if existing_idx >= 0:
    merged = dict(previous) if isinstance(previous, dict) else {}
    merged.update(job)
    doc["jobs"][existing_idx] = merged
else:
    doc["jobs"].append(job)

with open(jobs_path, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY

echo "Morning briefing cron job synced in: ${JOBS_FILE}"
