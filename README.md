# OpenClaw Docker

Production-grade OpenClaw runtime in Docker with:
- Telegram integration
- Clippy (M365 calendar/email)
- WHOOP Central
- Skills: tavily-search, weather, goplaces, self-improving-agent, playwright-mcp

## Quickstart

```bash
# 1. Setup environment
cp config/.env.example .env
# Edit .env with: COMPASS_API_KEY, TELEGRAM_BOT_TOKEN, OPENCLAW_GATEWAY_AUTH_TOKEN

# 2. Initialize and start
bin/openclawctl init
docker compose build
docker compose up -d

# 3. Validate and provision
bin/openclawctl validate
bin/openclawctl provision
```

## Azure VM

```bash
# Deploy
infra/azure/deploy.sh --resource-group <rg> --vm-name <vm> --location uaenorth

# Sync Clippy from laptop to VM
bin/openclawctl auth-clippy --host <vm-ip>
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize config |
| `provision` | Full sync + recreate + checks |
| `validate` | Prereqs + env + versions |
| `smoke` | Runtime smoke tests |
| `backup` | Backup runtime state |
| `restore <file>` | Restore from backup |
| `auth-clippy` | Sync Clippy auth |
| `auth-whoop` | Sync WHOOP auth |
| `cron-sync` | Sync cron workspace |

## Environment

Required `.env`:
- `COMPASS_API_KEY` - Model provider key
- `TELEGRAM_BOT_TOKEN` - Bot token
- `OPENCLAW_GATEWAY_AUTH_TOKEN` - Gateway auth
- `OPENCLAW_TELEGRAM_TARGET_ID` - Chat ID for cron messages

## Cron Jobs

### Setup

1. Copy profile template:
   ```bash
   cp templates/profile.yaml.example templates/profile.yaml
   # Edit with your details
   ```

2. Copy job templates:
   ```bash
   cp templates/jobs/*.md.example templates/jobs/
   # Edit job prompts as needed
   ```

3. Install jobs:
   ```bash
   bin/openclawctl cron-sync
   ```

### Customizing Jobs

Edit `templates/profile.yaml`:
```yaml
owner_name: John
local_timezone: Asia/Dubai
city: Abu Dhabi
```

Note: `telegram_target` comes from `.env` (`OPENCLAW_TELEGRAM_TARGET_ID`).

Edit `templates/jobs/morning-brief.md` to customize the morning briefing prompt.

### Dry-Run

Preview without installing:
```bash
scripts/cron/install-jobs.sh --dry-run
```

## Data

| Path | Purpose |
|------|---------|
| `data/.openclaw` | Runtime state |
| `data/workspace` | Agent workspace |
| `data/clippy` | Clippy auth |
| `data/whoop` | WHOOP credentials |

## Structure

```
.
├── bin/openclawctl          # CLI
├── config/                  # Config templates
│   ├── versions.env         # Version manifest
│   └── *.example
├── scripts/
│   ├── auth/               # Auth sync
│   ├── check/              # Validation
│   ├── cron/               # Workspace sync
│   └── runtime/            # Provision, backup
├── infra/azure/            # Azure deployment
├── docs/                   # Documentation
├── Dockerfile
└── docker-compose.yml
```

## Migration

| Old | New |
|-----|-----|
| `./scripts/provision-openclaw.sh` | `bin/openclawctl provision` |
| `./scripts/skills/` | Removed (skills in image) |
| `./scripts/image/` | Removed |
| `./infra/azure/sync-clippy-from-laptop.sh` | `bin/openclawctl auth-clippy --host <ip>` |
