#!/usr/bin/env bash
set -euo pipefail

CRON_WS_DIR="${1:-./data/.openclaw/workspace-cron}"
BIN_DIR="${CRON_WS_DIR}/bin"

mkdir -p "$BIN_DIR"

cat > "${BIN_DIR}/oc_exec_json.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "Usage: oc_exec_json.sh <source> <timeout_sec> -- <command...>" >&2
  exit 2
fi

SOURCE="$1"
TIMEOUT_SEC="$2"
shift 2

if [[ "$1" != "--" ]]; then
  echo "Usage: oc_exec_json.sh <source> <timeout_sec> -- <command...>" >&2
  exit 2
fi
shift

if [[ $# -lt 1 ]]; then
  echo "Missing command." >&2
  exit 2
fi

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
cleanup() {
  rm -f "$stdout_file" "$stderr_file"
}
trap cleanup EXIT

timed_out=false
exit_code=0

if command -v timeout >/dev/null 2>&1; then
  if ! timeout "${TIMEOUT_SEC}s" "$@" >"$stdout_file" 2>"$stderr_file"; then
    exit_code=$?
    if [[ "$exit_code" -eq 124 ]]; then
      timed_out=true
    fi
  fi
else
  if ! "$@" >"$stdout_file" 2>"$stderr_file"; then
    exit_code=$?
  fi
fi

python3 - "$SOURCE" "$exit_code" "$timed_out" "$*" "$stdout_file" "$stderr_file" <<'PY'
import json
import sys
from datetime import datetime, timezone

source = sys.argv[1]
exit_code = int(sys.argv[2])
timed_out = sys.argv[3].lower() == "true"
command = sys.argv[4]
stdout_path = sys.argv[5]
stderr_path = sys.argv[6]

def read_text(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read().rstrip("\n")

stdout_text = read_text(stdout_path)
stderr_text = read_text(stderr_path)

parsed = None
if stdout_text:
    try:
        parsed = json.loads(stdout_text)
    except Exception:
        parsed = None

doc = {
    "ok": exit_code == 0,
    "source": source,
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "exit_code": exit_code,
    "timed_out": timed_out,
    "command": command,
    "stdout": stdout_text,
    "stderr": stderr_text,
    "data": parsed,
}

print(json.dumps(doc, ensure_ascii=False))
PY
EOF

cat > "${BIN_DIR}/oc_whoop_today_json" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/oc_exec_json.sh" "whoop.today" "${OC_TIMEOUT_SEC:-30}" -- \
  /home/node/.openclaw/skills/whoop-central/scripts/whoop-central today --json
EOF

cat > "${BIN_DIR}/oc_calendar_today_json" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/oc_exec_json.sh" "clippy.calendar.today" "${OC_TIMEOUT_SEC:-30}" -- \
  clippy calendar --day today
EOF

cat > "${BIN_DIR}/oc_calendar_tomorrow_json" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/oc_exec_json.sh" "clippy.calendar.tomorrow" "${OC_TIMEOUT_SEC:-30}" -- \
  clippy calendar --day tomorrow
EOF

cat > "${BIN_DIR}/oc_email_unread_json" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/oc_exec_json.sh" "clippy.mail.unread" "${OC_TIMEOUT_SEC:-40}" -- \
  clippy mail inbox --unread --limit 30 --json
EOF

cat > "${BIN_DIR}/oc_weather_abu_dhabi_json" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/oc_exec_json.sh" "weather.abu_dhabi" "${OC_TIMEOUT_SEC:-20}" -- \
  weather "Abu Dhabi"
EOF

cat > "${BIN_DIR}/oc_news_ai_health_json" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/oc_exec_json.sh" "tavily.news.ai_health" "${OC_TIMEOUT_SEC:-45}" -- \
  tavily-search "latest AI healthcare digital health enterprise AI news" --topic news --days 2 -n 12 --deep
EOF

chmod 0755 \
  "${BIN_DIR}/oc_exec_json.sh" \
  "${BIN_DIR}/oc_whoop_today_json" \
  "${BIN_DIR}/oc_calendar_today_json" \
  "${BIN_DIR}/oc_calendar_tomorrow_json" \
  "${BIN_DIR}/oc_email_unread_json" \
  "${BIN_DIR}/oc_weather_abu_dhabi_json" \
  "${BIN_DIR}/oc_news_ai_health_json"

echo "Cron tooling synced at: ${BIN_DIR}"
