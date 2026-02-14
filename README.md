# OpenClaw Docker (Minimal Production Setup)

This repo runs OpenClaw in Docker with:
- Telegram channel integration
- Clippy (M365 calendar/email CLI)
- WHOOP Central
- Weather, Tavily, goplaces, playwright-mcp, self-improving-agent skills

## Effective Entrypoints

Current operator entrypoints are:
- `bin/openclawctl init` -> initialize runtime config
- `bin/openclawctl provision` -> full sync + recreate + checks
- `bin/openclawctl validate` -> prereqs + env + deploy guards
- `bin/openclawctl smoke` -> runtime smoke checks
- `bin/openclawctl auth-clippy` / `bin/openclawctl auth-whoop` -> auth syncs
- `bin/openclawctl cron-sync` -> cron workspace/tooling/template sync

Backwards-compatible wrappers are kept in `scripts/*.sh` for existing commands.
Detailed old->new mapping: `SCRIPT_MIGRATION.md`.

## Repo Layout

```text
.
├── bin/
│   └── openclawctl
├── scripts/
│   ├── auth/      # clippy/whoop auth sync
│   ├── check/     # validation, smoke tests, secret scan
│   ├── cron/      # cron templates + cron tooling/workspace sync
│   ├── runtime/   # provision, backup/restore, diagnostics, token rotation
│   ├── setup/     # config initialization
│   ├── skills/    # skill installers/syncers
│   └── lib/       # shared shell helpers
├── data/          # runtime state (host-mounted persistence)
├── Dockerfile
├── docker-compose.yml
├── openclaw.json.example
└── SECURITY_RUNBOOK.md
```

## Quickstart (Local)

```bash
cp .env.example .env
bin/openclawctl init
docker compose build
docker compose up -d
bin/openclawctl validate
bin/openclawctl provision
docker exec -it openclaw openclaw status
```

Optional first-time auth:

```bash
docker exec -it openclaw clippy login --interactive
docker exec -it openclaw sh -lc "/home/node/.openclaw/skills/whoop-central/scripts/whoop-central auth"
```

Required env keys for day-to-day use:
- `COMPASS_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `OPENCLAW_GATEWAY_AUTH_TOKEN`
- `OPENCLAW_TELEGRAM_TARGET_ID` (chat/user id used by cron message delivery)

## Azure VM Runbook

Use Ubuntu 22.04+ VM with Docker Engine + Compose v2.

```bash
git clone <your-repo-url> openclaw-docker
cd openclaw-docker
cp .env.example .env
# fill .env (COMPASS_API_KEY, TELEGRAM_BOT_TOKEN, OPENCLAW_GATEWAY_AUTH_TOKEN, etc.)

bin/openclawctl init
docker compose build
docker compose up -d
bin/openclawctl provision
```

Cloud-init option:
- Use `infra/azure/cloud-init.yaml` as custom data when creating the VM.
- Update `REPO_URL` in the file (or export it in cloud-init env) before use.

One-command Azure deploy script:
```bash
cp .env.azure.example .env.azure
# fill .env.azure once

infra/azure/deploy-azure.sh \
  --resource-group <rg> \
  --vm-name <vm-name> \
  --location uaenorth
```

The script auto-loads `.env.azure` if present, and CLI flags override file values.

Private mode (no public IP, no inbound NSG rules):
```bash
infra/azure/deploy-azure.sh \
  --resource-group <rg> \
  --vm-name <vm-name> \
  --private
```

Notes:
- `--copy-env` is intentionally blocked in `--private` mode.
- Use Bastion/VPN/jumpbox for VM access in private mode.
- Set `AZURE_REPO_URL` in `.env.azure` to your own public/private repo URL.

To also copy local `.env` and run remote build+provision:
```bash
infra/azure/deploy-azure.sh \
  --resource-group <rg> \
  --vm-name <vm-name> \
  --location uaenorth \
  --copy-env
```

Persistence:
- `data/.openclaw` -> OpenClaw state, config, cron jobs
- `data/workspace` -> agent workspace
- `data/clippy` -> Clippy auth cache
- `data/whoop` -> WHOOP auth files

Expose safely:
- Default bind is local-only (`127.0.0.1:18789`).
- Keep a reverse proxy/VPN in front if you need remote access.

## Security Defaults

- Non-root container user
- `cap_drop: [ALL]`
- `no-new-privileges:true`
- Read-only root filesystem by default (`OPENCLAW_READ_ONLY_ROOTFS=true`)
- Runtime config mount is read-only in container
- Secrets expected via `.env`; placeholders enforced in runtime config

See `SECURITY_RUNBOOK.md` for rotation and break-glass policy.

## Data Folder Policy

`data/` is runtime state, not source code.
- Expected permissions:
  - sensitive dirs: `700`
  - token/config JSON files: `600`
- Do not manually edit token files while runtime is active unless troubleshooting.
- Backup/restore is done with:
  - `bin/openclawctl backup`
  - `bin/openclawctl restore <archive>`

## Validation & Guardrails

```bash
bin/openclawctl validate
bin/openclawctl smoke
```

CI:
- `.github/workflows/deployment-guards.yml`
- `.github/workflows/sbom-and-scan.yml`
- `.github/dependabot.yml`

Manual secret scan:

```bash
scripts/check/check-secret-leaks.sh
```

Public-readiness checklist:
- Keep `.env`, `.env.azure`, and all `data/**` out of git.
- Run `scripts/check/check-secret-leaks.sh` before pushing.
- Avoid hardcoding names, chat IDs, locations, and repo URLs in scripts; use env vars.

## Troubleshooting

Container health:
```bash
docker ps
docker logs --tail 200 openclaw
```

Runtime diagnostics snapshot:
```bash
scripts/runtime/collect-diagnostics.sh openclaw
cat data/.openclaw/diagnostics/latest.json
```

Browser automation lock cleanup:
```bash
scripts/runtime/fix-browser-profile-lock.sh openclaw
```

Auth failures:
```bash
bin/openclawctl auth-clippy
bin/openclawctl auth-whoop
```

Temporary bypass (secure profile break-glass):
```bash
OPENCLAW_ALLOW_INSECURE_BYPASS=1 OPENCLAW_SKIP_AUTH_CHECKS=clippy,whoop bin/openclawctl provision
```

## Backward Compatibility

Legacy commands still work (thin wrappers), for example:
- `./scripts/provision-openclaw.sh`
- `./scripts/sync-clippy-auth.sh`
- `./scripts/sync-whoop-auth.sh`
- `./scripts/test-deploy-scripts.sh`
