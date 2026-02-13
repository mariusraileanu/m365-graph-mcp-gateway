# Script Migration Map

Preferred interface: `bin/openclawctl`.

## Kept Legacy Wrappers
- `scripts/init-config.sh` -> `scripts/setup/init-config.sh`
- `scripts/provision-openclaw.sh` -> `scripts/runtime/provision.sh`
- `scripts/sync-clippy-auth.sh` -> `scripts/auth/sync-clippy.sh`
- `scripts/sync-whoop-auth.sh` -> `scripts/auth/sync-whoop.sh`
- `scripts/test-deploy-scripts.sh` -> `scripts/check/test-deploy.sh`
- `scripts/test-runtime-smoke.sh` -> `scripts/check/test-runtime.sh`

## Removed Legacy Wrappers
Use these instead:
- `scripts/backup-runtime-state.sh` -> `scripts/runtime/backup-state.sh`
- `scripts/restore-runtime-state.sh` -> `scripts/runtime/restore-state.sh`
- `scripts/rotate-gateway-token.sh` -> `scripts/runtime/rotate-gateway-token.sh`
- `scripts/sync-briefing-cron.sh` -> `scripts/cron/sync-morning-brief.sh`
- `scripts/sync-evening-reflection-cron.sh` -> `scripts/cron/sync-evening-reflection.sh`
- `scripts/validate-env.sh` -> `scripts/check/validate-env.sh`
- `scripts/validate-prereqs.sh` -> `scripts/check/validate-prereqs.sh`
