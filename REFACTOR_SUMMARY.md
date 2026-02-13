# Refactor Summary

## What Changed and Why
- Introduced a single operator command: `bin/openclawctl`.
- Reorganized scripts by concern (`auth`, `check`, `cron`, `runtime`, `setup`, `skills`).
- Kept backward compatibility for major legacy commands via thin wrappers.
- Simplified Dockerfile by moving large inline scripts to tracked files under `scripts/image/`.
- Tightened repo hygiene with `.gitignore` for runtime/secrets.
- Rewrote docs to focus on practical onboarding and operations.

## New Folder Structure
- `bin/openclawctl`
- `scripts/auth/*`
- `scripts/check/*`
- `scripts/cron/*`
- `scripts/runtime/*`
- `scripts/setup/*`
- `scripts/skills/*`
- `scripts/lib/common.sh`
- `scripts/image/*`
- `README.md`
- `SECURITY_RUNBOOK.md`

## Removed / Merged
- Removed duplicated inline shell blocks in Dockerfile.
- Consolidated common operator workflows behind `bin/openclawctl`.
- Reduced top-level script sprawl by moving operational logic into subfolders.

## Migration Notes (Old → New)
- `./scripts/provision-openclaw.sh` → `bin/openclawctl provision`
- `./scripts/init-config.sh` → `bin/openclawctl init`
- `./scripts/test-deploy-scripts.sh` → `bin/openclawctl validate`
- `./scripts/test-runtime-smoke.sh` → `bin/openclawctl smoke`
- `./scripts/sync-clippy-auth.sh` → `bin/openclawctl auth-clippy`
- `./scripts/sync-whoop-auth.sh` → `bin/openclawctl auth-whoop`
- `./scripts/restore-runtime-state.sh` → `bin/openclawctl restore`
- `./scripts/rotate-gateway-token.sh` → `bin/openclawctl rotate-token`

## Validation Performed
- `scripts/check/test-deploy.sh`
- `bin/openclawctl validate`
- `docker compose build`
- `docker compose up -d --force-recreate`
- `OPENCLAW_ALLOW_INSECURE_BYPASS=1 OPENCLAW_SKIP_AUTH_CHECKS=clippy,whoop bin/openclawctl provision`
- `SKIP_CHECKS=clippy,whoop bin/openclawctl smoke`

## Run Commands

### Local
```bash
cp .env.example .env
bin/openclawctl init
docker compose build
docker compose up -d
bin/openclawctl validate
bin/openclawctl provision
docker exec -it openclaw openclaw status
```

### Azure VM
```bash
git clone <repo-url> openclaw-docker
cd openclaw-docker
cp .env.example .env
bin/openclawctl init
docker compose build
docker compose up -d
bin/openclawctl provision
```

### Rotate Tokens / Resync Auth
```bash
bin/openclawctl rotate-token
bin/openclawctl auth-clippy
bin/openclawctl auth-whoop
bin/openclawctl smoke
```
