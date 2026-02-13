# Repository Guidelines

## Project Structure & Module Organization
This repository packages a local OpenClaw runtime in Docker.
- `Dockerfile`: builds the `openclaw` image with OpenClaw, Tavily MCP, and Clippy.
- `docker-compose.yml`: runs the local service and mounts persistent volumes.
- `scripts/init-config.sh`: copies a config template into `data/.openclaw/openclaw.json`.
- `data/.openclaw/`: runtime state and effective OpenClaw config.
- `data/workspace/`: working files used by the running agent.
- `skills/`: optional local documentation/snippets.

## Build, Test, and Development Commands
Use Docker Compose for all local workflows.
- `cp .env.example .env`: create local environment file.
- `mkdir -p data/.openclaw data/workspace`: initialize mounted directories.
- `./scripts/init-config.sh`: bootstrap runtime config (idempotent).
- `docker compose build`: build/update the image.
- `docker compose up -d`: start in background.
- `docker compose logs -f openclaw`: stream service logs.
- `docker exec -it openclaw openclaw status`: verify the gateway is healthy.
- `docker exec -it openclaw openclaw mcp list`: verify MCP integrations.

## Coding Style & Naming Conventions
Keep changes small and operationally clear.
- Shell scripts: Bash with `set -euo pipefail`, lowercase variable names, quoted expansions.
- YAML/Docker files: 2-space indentation, stable key ordering when practical.
- Markdown docs: short sections, actionable steps, command examples in fenced blocks.
- Paths/scripts: prefer kebab-case filenames (for example `init-config.sh`).

## Testing Guidelines
There is no dedicated unit-test suite in this repo today.
Validate changes with runtime checks:
- Rebuild and restart: `docker compose build && docker compose up -d`.
- Health check: `docker exec -it openclaw openclaw status`.
- Integration smoke checks relevant to your change (for example MCP or Telegram setup).

## Commit & Pull Request Guidelines
Git history is not available in this workspace snapshot, so follow this baseline convention:
- Commit messages: imperative, scoped, concise (example: `docker: tighten container security options`).
- Keep one logical change per commit.
- PRs should include: purpose, risk/rollback notes, config/env changes, and verification commands/output.
- Attach screenshots only when UI behavior is affected.

## Security & Configuration Tips
- Never commit `.env` or secrets.
- Keep host binding local (`127.0.0.1:18789`) unless explicitly required.
- Review capability and privilege changes in `docker-compose.yml` carefully.
