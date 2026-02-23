# Copilot Instructions — m365-graph-mcp-gateway

## Scope

This repository is the **m365-graph-mcp-gateway** — a production MCP (Model Context Protocol) gateway for the Microsoft Graph API.

## Build & Run

```bash
npm run build          # TypeScript → dist/
npm run dev            # Watch mode (tsx)
npm run start          # Run built server
npm run ci             # Full CI: lint + format:check + build + test
npm run login          # Interactive browser auth
npm run login:device   # Device-code auth (headless)
```

## Architecture

```
src/
  auth/index.ts     MSAL delegated auth, token cache, getGraph(), login(), logout()
  config/index.ts   Loads config.yaml with ${ENV_VAR} expansion; Zod validated
  mcp/server.ts     HTTP + stdio MCP JSON-RPC server
  graph/            Graph API helpers per domain:
    calendar.ts       pickEvent()
    files.ts          pickFile(), searchFiles()
    mail.ts           pickMail(), buildMailAttachments(), createReplyDraft()
    retrieval.ts      Copilot Retrieval API client
  tools/            Intent-based tool definitions:
    auth.ts           Single auth tool (login/logout/whoami)
    find.ts           Cross-entity search (Copilot Retrieval + Graph Search)
    get.ts            get_email, get_event (fetch by ID)
    compose-email.ts  Draft/send/reply/reply-all
    schedule-meeting.ts  Find free time + create meeting
    respond-meeting.ts   Accept/decline/cancel + reply-all draft
    summarize.ts      AI summarization of any entity
    prepare-meeting.ts   Meeting context briefing
    audit.ts          Admin audit log
    index.ts          Aggregates all tools, exports callTool()
  utils/            Shared utilities:
    helpers.ts        ok(), fail(), compactText(), requireConfirm(), etc.
    types.ts          ToolSpec, ToolResult, MCPRequest, MCPResponse, etc.
    audit.ts          AuditLogger class for JSONL audit trail
    log.ts            Structured JSON logger
  public/index.html Web auth UI
  index.ts          Entry point: CLI args, main(), signal handlers
scripts/            Azure deployment automation (azure.sh)
```

Transport: `POST /mcp` (HTTP), `GET /health`, or stdin/stdout (stdio mode).

### Adding a new tool

1. Add a `ToolSpec` entry to the appropriate file in `src/tools/` (or create a new domain file).
2. Each tool needs: `name`, `description`, Zod `schema`, `inputSchema` (JSON Schema), and `run` handler.
3. If creating a new domain file, export the array and add it to `src/tools/index.ts`.

### ESM conventions

The project uses `"type": "module"` with ES2022 target. All local imports use `.js` extensions (e.g., `import { ok } from '../utils/helpers.js'`).

## Key Conventions

### Tool response shape

All tool responses follow a two-part contract (see `docs/TOOL_CONTRACT.md`):

- `content` — human-readable summary text
- `structuredContent` — machine-parseable payload
- `isError: true` only on failures

Use `ok()` and `fail()` helpers from `src/utils/helpers.ts`.

### Write safety

Destructive tools require `confirm=true`. Without it, they return a preview with `requires_confirmation=true`. Use `requireConfirm()`.

### Output minimization

Responses are compact by default. Callers pass `include_full=true` to expand. Use `pickMail()`, `pickEvent()`, `pickFile()` from `src/graph/`.

### Error pattern

Errors use a `CODE: message` convention (e.g., `RETRIEVAL_ERROR: ...`, `UPSTREAM_ERROR: ...`). The `normalizeError()` function standardizes caught errors.

## Configuration

- **Environment**: `GRAPH_MCP_CLIENT_ID` and `GRAPH_MCP_TENANT_ID` in `.env`
- **Runtime config**: `config.yaml` — scopes, guardrails, safety, output limits, retrieval settings
- Storage paths auto-resolve: container paths (`/home/node/...`) fall back to `./data/` on host
