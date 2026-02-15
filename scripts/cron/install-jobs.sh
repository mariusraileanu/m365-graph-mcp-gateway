#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

usage() {
  cat <<'EOF'
Install cron jobs from templates.

Usage:
  install-jobs.sh                    # Install jobs from templates/jobs/
  install-jobs.sh --dry-run         # Preview without installing
  install-jobs.sh --remove          # Remove jobs not in templates

Options:
  --dry-run    Preview changes without applying
  --remove     Remove jobs that exist but aren't in templates
  --container  Container name (default: openclaw)
EOF
}

DRY_RUN=0
REMOVE_MISSING=0
CONTAINER_NAME="openclaw"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --remove) REMOVE_MISSING=1; shift ;;
    --container) CONTAINER_NAME="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage >&2; exit 2 ;;
  esac
done

PROFILE_FILE="${ROOT_DIR}/templates/profile.yaml"
JOBS_DIR="${ROOT_DIR}/templates/jobs"

if [[ ! -f "$PROFILE_FILE" ]]; then
  echo "ERROR: Profile not found: $PROFILE_FILE" >&2
  echo "Copy templates/profile.yaml.example to templates/profile.yaml" >&2
  exit 1
fi

echo "Loading profile: $PROFILE_FILE"

get_profile() {
  grep -v '^#' "$PROFILE_FILE" | grep -v '^[[:space:]]*$' | while IFS=': ' read -r key value; do
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)
    echo "$key=$value"
  done
}

OWNER_NAME="User"
LOCAL_TIMEZONE="UTC"
CITY=""
TELEGRAM_TARGET=""

while IFS='=' read -r key value; do
  case "$key" in
    owner_name) OWNER_NAME="$value" ;;
    local_timez*) LOCAL_TIMEZONE="$value" ;;
    city) CITY="$value" ;;
  esac
done < <(get_profile)

# Load TELEGRAM_TARGET from .env
if [[ -f "${ROOT_DIR}/.env" ]]; then
  TELEGRAM_TARGET=$(grep '^OPENCLAW_TELEGRAM_TARGET_ID=' "${ROOT_DIR}/.env" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
fi

echo "Profile: $OWNER_NAME @ $LOCAL_TIMEZONE"

substitute() {
  local text="$1"
  text="${text//\{\{owner_name\}\}/${OWNER_NAME}}"
  text="${text//\{\{local_timez*\}\}/${LOCAL_TIMEZONE}}"
  text="${text//\{\{city\}\}/${CITY}}"
  text="${text//\{\{telegram_target\}\}/${TELEGRAM_TARGET}}"
  echo "$text"
}

install_job() {
  local job_file="$1"
  local job_name=""
  local schedule=""
  local session="isolated"
  local announce="true"
  local channel="telegram"
  local message=""
  local in_frontmatter=0
  local frontmatter_started=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "---" ]]; then
      if [[ "$frontmatter_started" -eq 0 ]]; then
        frontmatter_started=1
        in_frontmatter=1
        continue
      else
        in_frontmatter=0
        continue
      fi
    fi

    if [[ "$in_frontmatter" -eq 1 ]]; then
      if [[ "$line" =~ ^[[:space:]]*([a-z_]+):[[:space:]]*(.+)$ ]]; then
        local key="${BASH_REMATCH[1]}"
        local value="${BASH_REMATCH[2]}"
        value=$(echo "$value" | xargs)
        case "$key" in
          name) job_name="$value" ;;
          schedule) schedule="$value" ;;
          session) session="$value" ;;
          announce) announce="$value" ;;
          channel) channel="$value" ;;
        esac
      fi
    else
      message="${message}${line}"$'\n'
    fi
  done < "$job_file"

  if [[ -z "$job_name" || -z "$schedule" ]]; then
    echo "ERROR: Missing name or schedule in $job_file" >&2
    return 1
  fi

  message=$(substitute "$message")
  
  local to_arg=""
  if [[ -n "$TELEGRAM_TARGET" ]]; then
    to_arg="--to $TELEGRAM_TARGET"
  fi

  local cmd=(docker exec "$CONTAINER_NAME" openclaw cron add)
  cmd+=(--name "$job_name")
  cmd+=(--cron "$schedule")
  cmd+=(--tz "$LOCAL_TIMEZONE")
  cmd+=(--session "$session")
  cmd+=(--message "$message")

  if [[ "$announce" == "true" ]]; then
    cmd+=(--announce)
    cmd+=(--channel "$channel")
    [[ -n "$to_arg" ]] && cmd+=($to_arg)
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[DRY-RUN] Would install: $job_name"
    echo "  Schedule: $schedule"
    echo "  Session: $session"
    echo "  Announce: $announce"
    echo "  Message preview: $(echo "$message" | head -c 200)..."
  else
    echo "Installing: $job_name"
    if "${cmd[@]}"; then
      echo "  OK: $job_name"
    else
      echo "  ERROR: Failed to install $job_name" >&2
    fi
  fi
}

if [[ ! -d "$JOBS_DIR" ]]; then
  echo "ERROR: Jobs directory not found: $JOBS_DIR" >&2
  exit 1
fi

echo "Scanning: $JOBS_DIR"
job_count=0

for job_file in "$JOBS_DIR"/*.md; do
  [[ -f "$job_file" ]] || continue
  basename=$(basename "$job_file")
  [[ "$basename" == *.md.example ]] && continue
  
  install_job "$job_file"
  job_count=$((job_count + 1))
done

echo "Processed $job_count job(s)."