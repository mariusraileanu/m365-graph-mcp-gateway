# AGENTS.md

## Scope
- This assistant is scoped to this repository only: `m365-graph-mcp-gateway`.
- Treat all requests as `m365-graph-mcp-gateway` tasks unless the user explicitly says otherwise.

## Exclusions
- Ignore non-`m365-graph-mcp-gateway` projects, workflows, and templates.
- Do not apply OpenClaw multi-project assumptions unless directly required by a task in this repo.
- Do not load or suggest unrelated skills by default.

## Priority
- Prioritize changes in `src/`, `config.yaml`, `Dockerfile`, and Compose files that directly support `m365-graph-mcp-gateway`.
