# Cron Job Templates

OpenClaw cron jobs are defined via markdown templates.

## File Structure

```
templates/
├── profile.yaml           # User details
└── jobs/
    ├── morning-brief.md   # Job template
    └── evening-reflection.md
```

## Profile

Edit `templates/profile.yaml`:

```yaml
owner_name: John
local_timezone: Asia/Dubai
city: Abu Dhabi
```

Note: Telegram delivery target comes from `.env` (`OPENCLAW_TELEGRAM_TARGET_ID`).

| Variable | Description |
|---------|-------------|
| `owner_name` | Your name |
| `local_timezone` | IANA timezone (e.g., Asia/Dubai) |
| `city` | City for weather |

## Job Template Format

```markdown
---
name: Job Name
schedule: "0 8 * * *"
enabled: true
session: isolated
announce: true
channel: telegram
---

Your prompt here. Use {{owner_name}}, {{local_timezone}}, {{city}} for variables.
```

### Frontmatter Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| name | yes | - | Job name |
| schedule | yes | - | Cron expression |
| enabled | no | true | Enable/disable |
| session | no | isolated | main or isolated |
| announce | no | true | Deliver output |
| channel | no | telegram | Delivery channel |

## Cron Expression

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6)
* * * * *
```

Examples:
- `0 8 * * *` - Daily at 08:00
- `0 8 * * 1-5` - Weekdays at 08:00
- `0 18 * * *` - Daily at 18:00

## Setup

```bash
# 1. Copy templates
cp templates/profile.yaml.example templates/profile.yaml
cp templates/jobs/*.md.example templates/jobs/

# 2. Customize
vim templates/profile.yaml
vim templates/jobs/morning-brief.md

# 3. Install
bin/openclawctl cron-sync
```

## Dry-Run

Preview without installing:
```bash
scripts/cron/install-jobs.sh --dry-run
```
