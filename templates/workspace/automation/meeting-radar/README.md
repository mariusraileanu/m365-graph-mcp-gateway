# Meeting Radar Automation

This folder holds editable prompt/template content for the hourly Executive Meeting Radar cron job.

Files:
- `prompt.md`: main run instructions used by the cron job.

How to change behavior:
1. Edit `prompt.md`.
2. Run `bash scripts/provision.sh` to sync updates into:
   - `data/workspace/automation/meeting-radar`
   - `data/.openclaw/workspace/automation/meeting-radar`

Cron job execution reads:
- `/home/node/workspace/automation/meeting-radar/prompt.md`
