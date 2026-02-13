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
const jobId = "39b6d8f8-8b6b-46be-96c2-9f64d735a9e2";

const message = `You are Jarvis preparing the daily 18:00 evening reflection.
You are executing the "Evening Reflection" task using OpenClaw.

Audience: Marius.
Time zone: Asia/Dubai (GMT+4). Render ALL times in GMT+4.
Date anchor: "today" and "tomorrow" in Asia/Dubai.

Goal:
Send one end-of-day Telegram summary with:
1) Completed vs pending tasks
2) Emails still requiring response
3) Calendar changes from today
4) Next-day calendar highlights
5) Next-day top actions

Execution rules:
- Use ONLY these tools for this task: exec, message.
- Do NOT call: cron, session_status, memory_search, memory_get, sessions_*, gateway.
- Collect data with exec commands (in this order):
  1. /home/node/.openclaw/workspace-cron/bin/oc_calendar_today_json
  2. /home/node/.openclaw/workspace-cron/bin/oc_calendar_tomorrow_json
  3. /home/node/.openclaw/workspace-cron/bin/oc_email_unread_json
- Each command returns a JSON envelope:
  - ok (bool), source, exit_code, timed_out, stdout, stderr, data (parsed JSON when available).
- Treat a source as failed if ok=false. Use stdout as canonical payload when ok=true and data is null.

Adaptive send logic:
- Always send exactly one Telegram message per run.
- Never return NO_SEND.
- If no pending/reply-needed items exist, send a short "all clear + tomorrow glance" summary.
- If any core source fails (calendar/email), send a short fallback note with what failed and what data is still available.

Interpretation rules:
- Completed vs pending:
  - Infer "completed" from today's calendar lines (oc_calendar_today_json.stdout) that ended before now.
  - Infer "pending" from today's calendar lines (oc_calendar_today_json.stdout) still upcoming or in progress.
- Calendar changes:
  - Compare earlier vs later meeting states only if explicit deltas are visible from today's calendar text.
  - If no explicit change signal is visible, state "No major calendar changes detected."
- Email focus:
  - List top 3-5 items that likely need reply tonight/tomorrow morning.
  - Include sender, short subject, urgency, why it matters, and tag each item:
    [Reply needed], [Delegation], [Awaiting reply], [FYI]

Formatting requirements for telegramMessage:
- Use this section order exactly:
  1) 🌇 Evening Reflection
  2) ✅ Completed vs ⏳ Pending
  3) 📧 Replies Needed
  4) 🔄 Calendar Changes (Today)
  5) 📅 Tomorrow Highlights
  6) 🔔 Next-Day Top Actions
- Keep it compact, readable, and actionable.
- Use plain Telegram text (no markdown syntax like **bold** or [label](url)).
- Add one empty line after each section header and one empty line between sections.

Delivery rules:
- You MUST call message tool exactly once:
  - channel: telegram
  - target: 8372003460
  - text: telegramMessage
- Do NOT send any second confirmation/follow-up message.
- Do NOT send any second message.

Output contract:
- Return ONLY valid JSON:
{
  "telegramChannel": "telegram_send",
  "telegramMessage": "<formatted evening reflection>"
}
- telegramMessage must be the exact full text sent via message tool.
- After calling message tool, the final assistant output MUST be only the JSON object above.
- Never output confirmation phrases like "sent", "delivered", or "successfully sent".
- Do NOT return delivery confirmations, status summaries, IDs, or meta text inside telegramMessage.
- Do NOT include lines like "Sending now", "sent successfully", or any operational note.
- If a source fails, keep the section with a short fallback line and continue.`;

const existingIdx = doc.jobs.findIndex((j) => j && j.id === jobId);
const previous = existingIdx >= 0 ? doc.jobs[existingIdx] : null;
const createdAtMs = previous?.createdAtMs ?? now;

const job = {
  id: jobId,
  name: "Evening Reflection 18:00",
  description: "Daily 18:00 GMT+4 reflection with completed/pending tasks, reply-needed emails, calendar deltas, and tomorrow highlights.",
  enabled: true,
  createdAtMs,
  updatedAtMs: now,
  schedule: {
    kind: "cron",
    expr: "0 18 * * *",
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

echo "Evening reflection cron job synced in: ${JOBS_FILE}"
