#!/usr/bin/env bash
set -euo pipefail

# Smoke-test all MCP tools against a running gateway.
# Usage:
#   ./scripts/test-all-tools.sh                          # default: http://127.0.0.1:3000/mcp
#   BASE_URL=http://localhost:18790/mcp ./scripts/test-all-tools.sh   # custom URL
#   SKIP_CANCEL=1 ./scripts/test-all-tools.sh            # skip meeting cancellation

BASE_URL="${BASE_URL:-http://127.0.0.1:3000/mcp}"
HEALTH_URL="${BASE_URL%/mcp}/health"
HDR='content-type: application/json'
PASS=0
FAIL_COUNT=0
WARN_COUNT=0

log()  { printf '\n\033[1;34m[%s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*"; }
pass() { PASS=$((PASS+1)); printf '  \033[32m✓ %s\033[0m\n' "$*"; }
warn() { WARN_COUNT=$((WARN_COUNT+1)); printf '  \033[33m⚠ %s\033[0m\n' "$*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '  \033[31m✗ %s\033[0m\n' "$*"; }

mcp_call() {
  local id="$1" method="$2" params_json="$3"
  curl -sf "$BASE_URL" -H "$HDR" -d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"$method\",\"params\":$params_json}"
}

mcp_tool() {
  local id="$1" tool="$2" args_json="$3"
  mcp_call "$id" "tools/call" "{\"name\":\"$tool\",\"arguments\":$args_json}"
}

json_get() { node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);const v=($1);process.stdout.write(v===undefined||v===null?'':String(v));});"; }
is_error() { node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);const e=(j.result&&j.result.isError)||j.error;process.stdout.write(e?'1':'0');});"; }

assert_ok() {
  local label="$1" result="$2"
  if echo "$result" | is_error | grep -q '^0$'; then
    pass "$label"
  else
    fail "$label"
    echo "    $(echo "$result" | head -c 300)"
  fi
}

# ─── Health ──────────────────────────────────────────────
log "Health check"
HEALTH="$(curl -sf "$HEALTH_URL" || true)"
if [[ -z "$HEALTH" ]]; then
  fail "Gateway not running at $HEALTH_URL"
  exit 1
fi
pass "health"

# ─── tools/list ──────────────────────────────────────────
log "tools/list"
TOOLS="$(mcp_call 1 tools/list '{}')"
assert_ok "tools/list" "$TOOLS"

# ─── auth (whoami) ───────────────────────────────────────
log "auth (whoami)"
AUTH="$(mcp_tool 2 auth '{"action":"whoami"}')"
assert_ok "auth whoami" "$AUTH"
SELF_MAIL="$(echo "$AUTH" | json_get 'j.result?.structuredContent?.mail || j.result?.structuredContent?.user_principal_name')"
if [[ -z "$SELF_MAIL" ]]; then
  fail "Could not resolve self email — remaining tests will likely fail"
  exit 1
fi
echo "  User: $SELF_MAIL"

# ─── find (mail) ────────────────────────────────────────
log "find — mail"
R="$(mcp_tool 3 find '{"query":"budget","entity_types":["mail"],"top":3}')"
assert_ok "find mail" "$R"

# ─── find (files via Copilot Retrieval) ──────────────────
log "find — files"
R="$(mcp_tool 4 find '{"query":"budget","entity_types":["files"],"top":3}')"
assert_ok "find files" "$R"

# ─── find (events) ──────────────────────────────────────
log "find — events"
R="$(mcp_tool 5 find '{"query":"meeting","entity_types":["events"],"top":3}')"
assert_ok "find events" "$R"

# ─── find (all entity types) ────────────────────────────
log "find — all entities"
R="$(mcp_tool 6 find '{"query":"project update","top":5}')"
assert_ok "find all" "$R"

# ─── compose_email: send to self ────────────────────────
STAMP="$(date +%Y%m%d-%H%M%S)"
TEST_SUBJECT="[MCP TEST] smoke-$STAMP"
ATT_B64="$(printf 'Smoke test attachment %s\n' "$STAMP" | base64 | tr -d '\n')"

log "compose_email — send to self"
R="$(mcp_tool 10 compose_email "{\"mode\":\"send\",\"to\":\"$SELF_MAIL\",\"subject\":\"$TEST_SUBJECT\",\"body_html\":\"<p>Smoke test</p>\",\"attachments\":[{\"name\":\"smoke-$STAMP.txt\",\"content_base64\":\"$ATT_B64\",\"content_type\":\"text/plain\"}],\"confirm\":true}")"
assert_ok "compose_email send" "$R"

# ─── compose_email: draft ───────────────────────────────
log "compose_email — new draft"
DRAFT_R="$(mcp_tool 11 compose_email "{\"mode\":\"draft\",\"to\":\"$SELF_MAIL\",\"subject\":\"[MCP TEST DRAFT] $STAMP\",\"body_html\":\"<p>Draft only</p>\"}")"
assert_ok "compose_email draft" "$DRAFT_R"

# ─── get_email + reply tests using a received message ────
# Use an existing received message for reply tests (Graph can't reply to drafts or sent items)
log "Finding a received message for reply tests..."
INBOX_R="$(mcp_tool 12 find '{"query":"meeting OR update OR report OR request","entity_types":["mail"],"top":3}')"
INBOX_MSG_ID="$(echo "$INBOX_R" | json_get 'j.result?.structuredContent?.results?.[0]?.id')"

if [[ -n "$INBOX_MSG_ID" ]]; then
  echo "  Message ID: ${INBOX_MSG_ID:0:40}..."

  # ─── get_email ──────────────────────────────────────────
  log "get_email"
  R="$(mcp_tool 13 get_email "{\"message_id\":\"$INBOX_MSG_ID\"}")"
  assert_ok "get_email" "$R"

  # ─── compose_email: reply draft ─────────────────────────
  log "compose_email — reply draft"
  R="$(mcp_tool 14 compose_email "{\"mode\":\"reply\",\"message_id\":\"$INBOX_MSG_ID\",\"body_html\":\"<p>Reply draft test</p>\"}")"
  assert_ok "compose_email reply draft" "$R"

  # ─── compose_email: reply_all draft ─────────────────────
  log "compose_email — reply_all draft"
  R="$(mcp_tool 15 compose_email "{\"mode\":\"reply_all\",\"message_id\":\"$INBOX_MSG_ID\",\"body_html\":\"<p>Reply-all draft test</p>\"}")"
  assert_ok "compose_email reply_all draft" "$R"
else
  warn "No inbox messages found — skipping get_email/reply tests"
fi

# ─── schedule_meeting ────────────────────────────────────
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_UTC="$(node -e "const d=new Date();d.setUTCHours(d.getUTCHours()+1,0,0,0);console.log(d.toISOString());")"
END_UTC="$(node -e "const d=new Date();d.setUTCHours(d.getUTCHours()+1,30,0,0);console.log(d.toISOString());")"
RANGE_END="$(node -e "const d=new Date();d.setUTCDate(d.getUTCDate()+2);console.log(d.toISOString());")"
MEETING_SUBJECT="[MCP TEST] meeting-$STAMP"

log "schedule_meeting — preview (no confirm)"
R="$(mcp_tool 20 schedule_meeting "{\"subject\":\"$MEETING_SUBJECT\",\"start\":\"$START_UTC\",\"end\":\"$END_UTC\",\"attendees\":[\"$SELF_MAIL\"],\"teams_meeting\":true,\"agenda\":\"Smoke test agenda\"}")"
assert_ok "schedule_meeting preview" "$R"

log "schedule_meeting — confirm"
R="$(mcp_tool 21 schedule_meeting "{\"subject\":\"$MEETING_SUBJECT\",\"start\":\"$START_UTC\",\"end\":\"$END_UTC\",\"attendees\":[\"$SELF_MAIL\"],\"teams_meeting\":true,\"agenda\":\"Smoke test agenda\",\"confirm\":true}")"
assert_ok "schedule_meeting confirm" "$R"
EVENT_ID="$(echo "$R" | json_get 'j.result?.structuredContent?.id')"

if [[ -n "$EVENT_ID" ]]; then
  echo "  Event ID: ${EVENT_ID:0:40}..."

  # ─── get_event ──────────────────────────────────────────
  log "get_event"
  R="$(mcp_tool 22 get_event "{\"event_id\":\"$EVENT_ID\"}")"
  assert_ok "get_event" "$R"

  # ─── respond_to_meeting — accept ────────────────────────
  log "respond_to_meeting — accept preview"
  R="$(mcp_tool 23 respond_to_meeting "{\"event_id\":\"$EVENT_ID\",\"action\":\"accept\"}")"
  assert_ok "respond_to_meeting accept preview" "$R"

  log "respond_to_meeting — accept confirm"
  R="$(mcp_tool 24 respond_to_meeting "{\"event_id\":\"$EVENT_ID\",\"action\":\"accept\",\"confirm\":true}")"
  if echo "$R" | is_error | grep -q '^0$'; then
    pass "respond_to_meeting accept confirm"
  else
    warn "respond_to_meeting accept confirm (organizer responding to own meeting — expected)"
  fi

  # ─── respond_to_meeting — reply_all_draft ───────────────
  log "respond_to_meeting — reply_all_draft"
  R="$(mcp_tool 25 respond_to_meeting "{\"event_id\":\"$EVENT_ID\",\"action\":\"reply_all_draft\",\"body_html\":\"<p>Meeting reply-all test</p>\"}")"
  if echo "$R" | is_error | grep -q '^0$'; then
    pass "respond_to_meeting reply_all_draft"
  else
    warn "respond_to_meeting reply_all_draft (invite discovery can vary)"
  fi

  # ─── respond_to_meeting — cancel ────────────────────────
  if [[ "${SKIP_CANCEL:-0}" != "1" ]]; then
    log "respond_to_meeting — cancel preview"
    R="$(mcp_tool 26 respond_to_meeting "{\"event_id\":\"$EVENT_ID\",\"action\":\"cancel\",\"comment\":\"Smoke test cancel\"}")"
    assert_ok "respond_to_meeting cancel preview" "$R"

    log "respond_to_meeting — cancel confirm"
    R="$(mcp_tool 27 respond_to_meeting "{\"event_id\":\"$EVENT_ID\",\"action\":\"cancel\",\"comment\":\"Smoke test cancel\",\"confirm\":true}")"
    if echo "$R" | is_error | grep -q '^0$'; then
      pass "respond_to_meeting cancel confirm"
    else
      warn "respond_to_meeting cancel confirm (permissions edge case)"
    fi
  else
    warn "Skipping cancel (SKIP_CANCEL=1)"
  fi
else
  warn "Skipping event tests (no event_id)"
fi

# ─── summarize ───────────────────────────────────────────
log "summarize"
R="$(mcp_tool 30 summarize '{"query":"project update"}')"
assert_ok "summarize" "$R"

# ─── prepare_meeting ─────────────────────────────────────
log "prepare_meeting"
R="$(mcp_tool 31 prepare_meeting '{"subject":"upcoming meeting"}')"
assert_ok "prepare_meeting" "$R"

# ─── audit_list ──────────────────────────────────────────
log "audit_list"
R="$(mcp_tool 40 audit_list '{"limit":20}')"
assert_ok "audit_list" "$R"

# ─── Summary ────────────────────────────────────────────
echo ""
log "Results: $PASS passed, $FAIL_COUNT failed, $WARN_COUNT warnings"
[[ "$FAIL_COUNT" -eq 0 ]] && printf '\033[32mAll smoke tests passed!\033[0m\n' || printf '\033[31mSome tests failed.\033[0m\n'
exit "$FAIL_COUNT"
