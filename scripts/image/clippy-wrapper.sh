#!/usr/bin/env bash
set -euo pipefail

# Compatibility + timezone shim for legacy prompts/agents.
# This normalizes calendar outputs to Asia/Dubai (GMT+4) to avoid source-timezone confusion.

run_clippy() {
  exec /opt/bun/bin/bun --cwd /opt/clippy ./src/cli.ts "$@"
}

ensure_outlook_token() {
  local cmd="${1:-}"
  local cache_path="${HOME}/.config/clippy/token-cache.json"

  case "$cmd" in
    login|refresh)
      return 0
      ;;
  esac

  [[ -f "$cache_path" ]] || return 0

  node - "$cache_path" <<'NODE' || true
const fs = require('fs');

const cachePath = process.argv[2];

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}

async function main() {
  const raw = fs.readFileSync(cachePath, 'utf8');
  const cache = JSON.parse(raw);
  const currentAud = decodeJwt(cache.token || '')?.aud;

  if (currentAud === 'https://outlook.office.com') return;
  if (!cache.refreshToken) return;

  const body = new URLSearchParams({
    client_id: '9199bf20-a13f-4107-85dc-02114787ef48',
    grant_type: 'refresh_token',
    refresh_token: cache.refreshToken,
    scope: 'https://outlook.office.com/.default offline_access',
  });

  const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://outlook.office.com',
    },
    body: body.toString(),
  });

  if (!resp.ok) return;

  const json = await resp.json();
  const payload = decodeJwt(json.access_token || '');
  if (!payload || payload.aud !== 'https://outlook.office.com') return;

  cache.token = json.access_token;
  cache.refreshToken = json.refresh_token || cache.refreshToken;
  cache.expiresAt = payload.exp ? payload.exp * 1000 : Date.now() + 55 * 60 * 1000;

  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  console.log('[clippy-wrapper] Updated token-cache with Outlook-scoped access token.');
}

main().catch(() => {});
NODE
}

run_calendar_dubai() {
  local want_json="0"
  local day_arg=""
  local args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --day|--start)
        day_arg="${2:-}"
        shift 2
        ;;
      --week)
        day_arg="week"
        shift
        ;;
      --details)
        args+=("-v")
        shift
        ;;
      --format)
        if [[ "${2:-}" == "json" ]]; then
          want_json="1"
        fi
        shift 2
        ;;
      --json)
        want_json="1"
        shift
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done

  local tmp_json
  tmp_json="$(mktemp)"
  if [[ -n "$day_arg" ]]; then
    /opt/bun/bin/bun --cwd /opt/clippy ./src/cli.ts calendar "$day_arg" "${args[@]}" --json >"$tmp_json"
  else
    /opt/bun/bin/bun --cwd /opt/clippy ./src/cli.ts calendar "${args[@]}" --json >"$tmp_json"
  fi

  python3 - "$tmp_json" "$want_json" <<'PY'
import json
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

src = sys.argv[1]
want_json = sys.argv[2] == "1"

with open(src, "r", encoding="utf-8") as f:
    data = json.load(f)

if not isinstance(data, list):
    print(json.dumps(data, ensure_ascii=False))
    raise SystemExit(0)

tz_alias = {
    "Arabian Standard Time": "Asia/Dubai",
}

def to_dubai(dt_str, tz_name):
    if not dt_str:
        return None
    z = tz_alias.get(tz_name, tz_name or "UTC")
    try:
        src_tz = ZoneInfo(z)
    except Exception:
        src_tz = ZoneInfo("UTC")
    dt = datetime.fromisoformat(dt_str).replace(tzinfo=src_tz)
    return dt.astimezone(ZoneInfo("Asia/Dubai"))

out = []
for e in data:
    e2 = dict(e)
    start = dict(e2.get("Start") or {})
    end = dict(e2.get("End") or {})
    sdt = to_dubai(start.get("DateTime"), start.get("TimeZone"))
    edt = to_dubai(end.get("DateTime"), end.get("TimeZone"))
    if sdt:
        start["DateTime"] = sdt.isoformat(timespec="seconds")
        start["TimeZone"] = "Asia/Dubai"
    if edt:
        end["DateTime"] = edt.isoformat(timespec="seconds")
        end["TimeZone"] = "Asia/Dubai"
    e2["Start"] = start
    e2["End"] = end
    out.append((sdt, edt, e2))

out.sort(key=lambda x: (x[0] or datetime.min.replace(tzinfo=ZoneInfo("UTC"))))
events = [x[2] for x in out]

if want_json:
    print(json.dumps(events, ensure_ascii=False, indent=2))
else:
    if not out:
        print("No events found.")
        raise SystemExit(0)
    first = out[0][0]
    title_date = first.strftime("%a, %b %d") if first else "Selected day"
    print(f"\n📆 Calendar for {title_date} (GMT+4, Abu Dhabi)")
    print("────────────────────────────────────────")
    for idx, (sdt, edt, ev) in enumerate(out, start=1):
        subject = ev.get("Subject", "Untitled")
        loc = ((ev.get("Location") or {}).get("DisplayName") or "No location")
        if sdt and edt:
            print(f"  {idx:>2}. {sdt:%H:%M} - {edt:%H:%M}: {subject}")
        else:
            print(f"  {idx:>2}. {subject}")
        print(f"      📍 {loc}")
PY
  rm -f "$tmp_json"
}

if [[ "${1:-}" == "events" || "${1:-}" == "agenda" ]]; then
  shift
  set -- calendar "$@"
fi

ensure_outlook_token "${1:-}"

if [[ "${1:-}" == "calendar" ]]; then
  shift
  run_calendar_dubai "$@"
  exit 0
fi

run_clippy "$@"
