# TOOLS.md - Local Notes

Skills define *how* tools work. This file is for *your* specifics — the stuff that's unique to your setup.

This helps Jarvis understand your environment, integrations, and tool preferences.

---

## 🧰 Email & Calendar Tools

### Microsoft 365 (M365) — Outlook Email & Calendar

- **Primary email & calendar provider:** Microsoft 365 via **Graph MCP Gateway**
- Graph MCP Gateway is connected to your **Outlook mailbox** and **Outlook calendar** (M365), handling:
  - Reading and summarizing emails
  - Extracting meeting details from calendar
  - Scheduling, rescheduling, and cancelling meetings
  - Creating, updating, and managing calendar events

**Access:**

- Graph MCP Gateway runs on `http://localhost:18790/mcp` inside the container
- Local CLI wrappers:
  - Mail:
    - `mail-unread`, `mail-read`, `mail-search`
    - `mail-draft`, `mail-draft-reply-all`, `mail-send`
  - Calendar:
    - `calendar-next`, `calendar-read`, `calendar-today`, `calendar-tomorrow`, `calendar-week`, `calendar-free`
    - `meeting-radar` (deterministic executive meeting format renderer)
    - `calendar-create`, `calendar-respond`
  - SharePoint/OneDrive:
    - `sharepoint-file-search`, `sharepoint-file-name-search`, `sharepoint-file-content-search`
  - Summarization:
    - `summarize`
  - Legacy compatibility:
    - `graph-mcp`, `graph-mcp-write`, `graph-mcp-send`
- Available tools: `list_unread`, `search_emails`, `search_files`, `get_email`, `send_email`, `draft_email`, `list_calendar`, `get_event`, `draft_reply_all_event`, `create_meeting`, `respond_event`, `find_free_slots`
- Current delegated permissions configured for Graph MCP Gateway:
  - `Calendars.Read`, `Calendars.Read.Shared`, `Calendars.ReadWrite`
  - `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`
  - `User.Read`
  - `Files.Read.All`, `Sites.Read.All`, `Sites.Selected`

**Rules:**

- Treat Graph MCP Gateway as the **canonical source of truth** for inbox + calendar.
- Prefer JSON output whenever available.
- Never answer calendar questions from memory — run a live command in the same turn.
- If a command fails, report the failure briefly and include the exact command that failed.
- **Domain allowlist enforced:** Only `@doh.gov.ae`, `@gmail.com`, `@outlook.com` allowed for sending emails.
- Use mail read commands:
  - `mail-unread <n>`
  - `mail-read <message_id>`
  - `mail-search [top] <query>`
- Use SharePoint/OneDrive commands:
  - `sharepoint-file-search [top] <query>`
  - `sharepoint-file-name-search [top] <query>`
  - `sharepoint-file-content-search [top] <query>`
- Use calendar read commands:
  - `calendar-next [minutes]`
  - `calendar-read <start_iso> <end_iso>`
  - `calendar-today`
  - `calendar-tomorrow`
  - `calendar-week`
  - `calendar-free <start_iso> <end_iso> [duration_minutes]`
  - `meeting-radar <today|tomorrow|week|next> [minutes]`
- Use summarization command:
  - `summarize <url_or_file_path> [flags]`
- For meeting context enrichment, prefer organizer + subject keyword mailbox search via `mail-search`, not unread-only scans.
- Use write commands:
  - `mail-draft <to> <subject> <body>`
  - `mail-draft-reply-all <event_id> <body>`
  - `calendar-respond <event_id> <accept|decline|tentativelyAccept>`
  - `calendar-create <subject> <start_iso> <end_iso> [attendees_csv] [body]`
- `mail-draft-reply-all` is the preferred path for meeting invite replies because it preserves Outlook thread history.
- Use `mail-send` only when you explicitly want to send immediately and have already reviewed a draft preview.
- For direct send, require explicit confirmation intent and use `mail-send --send-now ...`.
- For file results shared with users, format each item with icons and include browser-openable links by forcing `web=1` on the file URL.

---

## 📡 Notification Channel

### Telegram

- **Primary delivery channel** for all alerts, reminders, and notifications.
- Jarvis uses your configured Telegram bot token + chat ID to send messages.

**Send pattern:**

```bash
openclaw message send --channel telegram --target <CHAT_ID> --message "..."
```

---

## 🧠 Model & Task Routing

### Transcription

- **Preferred model:** Whisper (medium) for accurate audio transcriptions (calls, recordings, meetings).

### Web Search

- **Preferred web search tool:** Tavily for external context / open research.
- **Hard rule:** Use only Tavily for web search.
- Do not use Brave or web_fetch.
- **Execution:** Use the Tavily skill path (no custom wrapper required).
- Do not chain commands (`cd`, `&&`, etc.).

### Task Execution

- Calendar & email manipulation must always go through Graph MCP Gateway (M365).
- Validate key claims against live tools in the same turn whenever possible.

---

## 🍽 Restaurant Discovery & Booking

### Discovery

- Primary: `goplaces`
- Fallback: `tavily-search`

### Booking execution

- Use browser automation (e.g., Playwright MCP skill).
- Must use official booking page.
- Do not switch to phone-call/manual instructions unless the user explicitly requests it.

### Candidate ranking

1. Rating (descending)
2. Review count (descending)
3. Distance (ascending, Abu Dhabi bias)

---

## 🧠 Integrations & Data Signals

### WHOOP (Health Data)

- WHOOP readiness / sleep / strain integration
- Used in daily briefs and readiness-based scheduling recommendations
- WHOOP signals inform decisions — they do not auto-modify calendar events

---

## 🗣 TTS & Voice (Optional)

### ElevenLabs (sag)

- Preferred voice: Nova
- Default delivery: Telegram voice note

---

## 🔐 Security Rules

- Never place credentials in markdown.
- Never store plaintext API keys.
- Keep secrets in environment variables or a secure vault.
- Do not exfiltrate private data.
- Do not run destructive system commands without explicit confirmation.

Inbox + calendar are private contexts. Do not leak them in shared chats.

---

## 🛠 Notes & To-Dos

- Store Telegram chat ID securely.
- Define M365 priority filters (senior leadership list, urgency keywords).
- Keep WHOOP readiness threshold documented if used.
- Ensure tokens and OAuth credentials are stored securely.

---

## Why Separate?

Skills are shared. Your setup is yours.

Keeping local notes here allows you to:
- Update skills without losing environment specifics
- Share skills without leaking infrastructure
- Maintain deterministic, consistent tool routing
