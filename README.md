# m365-graph-mcp-gateway

Production-ready MCP gateway for Microsoft 365 Graph API with MSAL authentication, guardrails, and Copilot Retrieval API integration.

## Features

- **Mail**: list, search, get, draft, reply, reply-all, send (confirm-gated)
- **Calendar**: list, get, free-slots, create (Teams meetings + agenda), respond, cancel
- **Files**: SharePoint/OneDrive search and content extraction
- **Copilot Retrieval API**: AI-grounded semantic search across SharePoint and OneDrive
- **Cross-entity search**: find across mail, files, and calendar events
- **Guardrails**: email domain allowlist, attachment limits, HTML sanitization, audit logging
- **Safety**: write operations require explicit `confirm=true`

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env
# Set GRAPH_MCP_CLIENT_ID and GRAPH_MCP_TENANT_ID

# Build
npm run build

# Login (interactive browser)
npm run login

# Start server
npm run start
```

## Authentication

### Interactive browser login (recommended)

```bash
npm run login
# Opens browser for Microsoft sign-in
```

### Device code login (headless/SSH)

```bash
npm run login:device
# Displays a code to enter at https://microsoft.com/devicelogin
```

### Web UI login (Docker)

Start the server, then open `http://localhost:3000/` to sign in via browser.

### Azure AD App Registration

Register an app in Azure AD with these settings:

- **Redirect URI**: `http://localhost:3000/auth/callback` (SPA type)
- **API Permissions** (delegated): `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.Read`, `Calendars.ReadWrite`, `User.Read`, `Files.Read.All`, `Sites.Read.All`

Set `PUBLIC_HOST` if using a non-default port (e.g., `PUBLIC_HOST=http://localhost:18790`).

## MCP Endpoints

| Endpoint       | Method | Description           |
| -------------- | ------ | --------------------- |
| `/mcp`         | POST   | MCP JSON-RPC endpoint |
| `/health`      | GET    | Health check          |
| `/auth/status` | GET    | Auth status (JSON)    |
| `/`            | GET    | Web auth UI           |

### Example MCP call

```bash
curl -s http://localhost:3000/mcp -d '{
  "jsonrpc": "2.0", "id": 1,
  "method": "tools/call",
  "params": { "name": "find", "arguments": { "query": "budget report", "entity_types": ["files"] } }
}' | jq
```

## Configuration

`config.yaml` controls scopes, guardrails, output limits, and the Copilot Retrieval API:

```yaml
retrieval:
  enabled: true
  dataSource: 'sharePoint' # or "oneDriveBusiness"
```

See `config.yaml` for all options.

## Docker

```bash
# Build and start
docker compose build && docker compose up -d

# Login via device code in container
docker compose run --rm -it m365-graph-mcp-gateway node dist/index.js --login-device

# Or use the web UI at http://localhost:18790/

# Health check
curl -s http://localhost:18790/health | jq

# Logs
docker compose logs -f m365-graph-mcp-gateway
```

## Deploy to Azure

Uses Terraform to deploy as an Azure Container App.

```bash
# 1. Build and push Docker image to your registry
docker build -t myregistry.azurecr.io/graph-mcp-gateway:latest .
docker push myregistry.azurecr.io/graph-mcp-gateway:latest

# 2. Deploy
export GRAPH_MCP_CLIENT_ID="your-client-id"
export GRAPH_MCP_TENANT_ID="your-tenant-id"
export CONTAINER_IMAGE="myregistry.azurecr.io/graph-mcp-gateway:latest"
bash scripts/deploy.sh
```

See `infra/terraform.tfvars.example` for all Terraform variables.

## Project Structure

```
src/
  auth/         MSAL login, token cache, Graph client
  config/       YAML config loader with Zod validation
  graph/        Graph API modules (calendar, files, mail, retrieval)
  mcp/          HTTP + stdio MCP JSON-RPC server
  tools/        MCP tool definitions (find, get, compose-email, etc.)
  utils/        Helpers, audit logger, types, structured logging
  public/       Web auth UI
  index.ts      Entry point
infra/          Terraform for Azure Container Apps
scripts/        Deploy and test scripts
```

## Development

```bash
npm run dev           # Watch mode
npm run lint          # ESLint
npm run format        # Prettier
npm run ci            # Full CI: lint + format:check + build + test
```

## Tool Contract

See [`docs/TOOL_CONTRACT.md`](docs/TOOL_CONTRACT.md) for the full agent-facing reference:
tool names, parameter schemas, response shapes, multi-step workflow patterns, error codes, and write-safety rules.
Pass it as context when configuring an LLM agent that consumes this gateway.

## Safety Defaults

- `mail_send`, `calendar_create_meeting`, `calendar_respond`, `calendar_cancel_meeting` require `confirm=true`
- Outbound email recipients are domain-allowlisted
- Audit log records all write actions and blocked attempts
