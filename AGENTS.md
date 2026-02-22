# AGENTS.md

## Scope

- This assistant is scoped to this repository only: `m365-graph-mcp-gateway`.
- Treat all requests as `m365-graph-mcp-gateway` tasks unless the user explicitly says otherwise.

## Exclusions

- Ignore non-`m365-graph-mcp-gateway` projects, workflows, and templates.
- Do not apply OpenClaw multi-project assumptions unless directly required by a task in this repo.
- Do not load or suggest unrelated skills by default.

## Priority

- Prioritize changes in `src/`, `config.yaml`, `Dockerfile`, and Compose files.

## Project Structure

```
src/auth/         MSAL authentication, token cache, Graph client
src/config/       YAML config loader with Zod validation
src/graph/        Graph API modules (calendar, files, mail, retrieval)
src/mcp/          HTTP + stdio MCP JSON-RPC server
src/tools/        MCP tool definitions
src/utils/        Helpers, audit, types, structured logging
src/public/       Web auth UI
infra/            Terraform for Azure Container Apps
```

## Build & Test

```bash
npm run build       # TypeScript build
npm run ci          # Full CI: lint + format:check + build + test
npm run dev         # Watch mode
```

## Tool Contract

The canonical reference for all MCP tools exposed by this gateway is
[`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md). It documents every tool's
parameters, response shapes, multi-step workflows, error codes, and write-safety
rules. Consult it when modifying or adding tools.
