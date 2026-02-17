# Inbox Obligations Tracker

This template drives the cron job `Inbox Obligations Tracker (Executive Radar)`.

Behavior:
- Scans mailbox signals for real obligations from commitments, approvals, and deadlines.
- Uses a rolling 14-day email window (read + unread).
- Prioritizes by deadline proximity, sender seniority, escalation risk, and unresolved age.
- Sends one Telegram message only when action is required.
- Returns `NO_REPLY` when no actionable obligations exist.

Provisioning:
- Job is created/updated by `scripts/setup-cron.sh` during `scripts/provision.sh`.
