#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONTAINER_NAME="openclaw"
CLI=(docker exec "$CONTAINER_NAME" node /opt/openclaw/openclaw.mjs)

if [[ ! -f .env ]]; then
  echo "ERROR: .env file not found."
  exit 1
fi

get_env_var() {
  local key="$1"
  python3 - "$key" <<'PY'
import re
import sys

target = sys.argv[1]
values = {}

with open(".env", "r", encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k):
            continue
        v = v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        values[k] = v

print(values.get(target, ""))
PY
}

TELEGRAM_TARGET_ID="$(get_env_var OPENCLAW_TELEGRAM_TARGET_ID)"
if [[ -z "$TELEGRAM_TARGET_ID" ]]; then
  echo "ERROR: OPENCLAW_TELEGRAM_TARGET_ID is not set in .env"
  exit 1
fi

JOB_TZ="Asia/Dubai"

find_job_id() {
  local target_name="$1"
  local jobs_json
  jobs_json="$("${CLI[@]}" cron list --json)"
  python3 - "$target_name" "$jobs_json" <<'PY'
import json
import sys

name = sys.argv[1]
data = json.loads(sys.argv[2])
for job in data.get("jobs", []):
    if job.get("name") == name:
        print(job.get("id", ""))
        break
PY
}

ensure_cron_job() {
  local job_name="$1"
  local job_description="$2"
  local job_cron_expr="$3"
  local job_message="$4"

  local job_id
  job_id="$(find_job_id "$job_name")"

  if [[ -n "$job_id" ]]; then
    echo "Updating cron job: $job_name ($job_id)"
    "${CLI[@]}" cron edit "$job_id" \
      --name "$job_name" \
      --description "$job_description" \
      --cron "$job_cron_expr" \
      --tz "$JOB_TZ" \
      --session isolated \
      --message "$job_message" \
      --announce \
      --channel telegram \
      --to "$TELEGRAM_TARGET_ID" \
      --wake now \
      --enable >/dev/null
  else
    echo "Creating cron job: $job_name"
    "${CLI[@]}" cron add \
      --name "$job_name" \
      --description "$job_description" \
      --cron "$job_cron_expr" \
      --tz "$JOB_TZ" \
      --session isolated \
      --message "$job_message" \
      --announce \
      --channel telegram \
      --to "$TELEGRAM_TARGET_ID" \
      --wake now >/dev/null
  fi

  echo "Cron job ensured: $job_name"
}

ensure_cron_job \
  "Executive Meeting Radar" \
  "Hourly executive brief for meetings in next 60 minutes" \
  "0 * * * *" \
  "Read /home/node/workspace/automation/meeting-radar/prompt.md and execute it exactly. If no meetings in next 60 minutes, return HEARTBEAT_OK only."

ensure_cron_job \
  "Inbox Obligations Tracker (Executive Radar)" \
  "Hourly obligations radar from inbox commitments, approvals, and deadlines" \
  "0 * * * *" \
  "Read /home/node/workspace/automation/inbox-obligations-radar/prompt.md and execute it exactly. If there are no real obligations requiring attention, return NO_REPLY only."
