# m365-graph-mcp-gateway

Production-ready MCP gateway for Microsoft 365 Graph API with MSAL authentication and guardrails.

## Features

- **Mail**: list, search, get, draft, reply, reply-all, send (confirm-gated)
- **Calendar**: list, get, free-slots, create (Teams meetings + agenda), respond, cancel
- **Files**: SharePoint/OneDrive search and content extraction
- **Cross-entity search**: find across mail, files, and calendar events
- **Guardrails**: email domain allowlist, attachment limits, HTML sanitization, audit logging
- **Safety**: write operations require explicit `confirm=true`

## Quick Start (Local)

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

1. Go to **Azure Portal > App registrations > New registration**
2. Set a name (e.g., `graph-mcp-gateway`)
3. Under **Supported account types**, select "Accounts in this organizational directory only (Single tenant)"
4. Under **Redirect URIs**, add:
   - Type: **SPA**
   - URI: `http://localhost:3000/auth/callback`
5. Click **Register**
6. Note the **Application (client) ID** and **Directory (tenant) ID** — you'll need these

**API Permissions** (all Delegated):

| Permission              | Type      | Description                        |
| ----------------------- | --------- | ---------------------------------- |
| `Mail.Read`             | Delegated | Read user mail                     |
| `Mail.ReadWrite`        | Delegated | Read and write user mail           |
| `Mail.Send`             | Delegated | Send mail as user                  |
| `Calendars.Read`        | Delegated | Read user calendars                |
| `Calendars.Read.Shared` | Delegated | Read shared calendars              |
| `Calendars.ReadWrite`   | Delegated | Read and write user calendars      |
| `User.Read`             | Delegated | Sign in and read user profile      |
| `Files.Read.All`        | Delegated | Read all files user can access     |
| `Sites.Read.All`        | Delegated | Read items in all site collections |

> Grant admin consent for your tenant after adding permissions.

Set `PUBLIC_HOST` if using a non-default port (e.g., `PUBLIC_HOST=http://localhost:18790`).

## MCP Endpoints

| Endpoint       | Method | Description           |
| -------------- | ------ | --------------------- |
| `/mcp`         | POST   | MCP JSON-RPC endpoint |
| `/health`      | GET    | Health check          |
| `/auth/status` | GET    | Auth status (JSON)    |
| `/`            | GET    | Web auth UI           |

The MCP server accepts plain JSON-RPC POST requests — no SSE, no sessions. Each request is independent.

### Example MCP call

```bash
curl -s http://localhost:3000/mcp -d '{
  "jsonrpc": "2.0", "id": 1,
  "method": "tools/call",
  "params": { "name": "find", "arguments": { "query": "budget report", "entity_types": ["files"] } }
}' | jq
```

## Configuration

`config.yaml` controls scopes, guardrails, and output limits:

```yaml
guardrails:
  email:
    allowDomains:
      - '*.example.com' # restrict outbound email to your org
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

---

## Deploy to Azure Container Apps

This section walks through deploying the gateway to Azure Container Apps. The architecture deploys **per-user Container App instances** into shared Azure infrastructure. Each user gets their own isolated container with:

- Separate MSAL credentials and Graph API token
- NFS-backed persistent storage for token cache and audit logs
- Scale-to-zero by default (no cost when idle)
- Internal-only networking (no public internet exposure)

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Resource Group                                                 │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │  ACR         │  │  Key Vault  │  │  Log Analytics          │ │
│  │  (images)    │  │  (secrets)  │  │  (logs)                 │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                 │
│  ┌──────────────────── VNet (10.0.0.0/16) ───────────────────┐ │
│  │                                                            │ │
│  │  ┌──── snet-containerapps (/23) ────────────────────────┐ │ │
│  │  │  Container Apps Environment (internal-only)          │ │ │
│  │  │                                                      │ │ │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌─────────────┐  │ │ │
│  │  │  │ ca-...-alice │ │ ca-...-bob   │ │ ca-...-jdoe │  │ │ │
│  │  │  │  :3000/mcp   │ │  :3000/mcp   │ │  :3000/mcp  │  │ │ │
│  │  │  └──────┬───────┘ └──────┬───────┘ └──────┬──────┘  │ │ │
│  │  │         └────────────────┼─────────────────┘         │ │ │
│  │  │                    NFS Volume Mount                   │ │ │
│  │  └──────────────────────────┼───────────────────────────┘ │ │
│  │                             │                              │ │
│  │  ┌──── snet-privateendpoints (/24) ─────────────────────┐ │ │
│  │  │  Private Endpoint ──► Storage Account (NFS)          │ │ │
│  │  │                       ┌────────────────────────┐     │ │ │
│  │  │                       │  /data/alice/graph-mcp │     │ │ │
│  │  │                       │  /data/bob/graph-mcp   │     │ │ │
│  │  │                       │  /data/jdoe/graph-mcp  │     │ │ │
│  │  │                       └────────────────────────┘     │ │ │
│  │  └──────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

Each user's container writes tokens and audit logs to their own directory on the shared NFS mount. The storage account is accessed only through a private endpoint — no public network access.

### Prerequisites

1. **Azure CLI** with the `containerapp` extension:

   ```bash
   # Install Azure CLI: https://aka.ms/installazurecli
   az extension add --name containerapp --upgrade
   az login
   ```

2. **Azure subscription** with permissions to create:
   - Resource Groups, Container Registries, Key Vaults
   - Virtual Networks, Private Endpoints, Private DNS Zones
   - Container Apps Environments, Container Apps
   - Storage Accounts (Premium FileStorage)

3. **Azure AD App Registration** — see [Azure AD App Registration](#azure-ad-app-registration) above. You need the **Client ID** and **Tenant ID**.

4. **Node.js 22+** and **npm** (for local builds / TypeScript compilation)

### Step 1: Configure Environment Files

You need two environment files — one for app secrets, one for Azure resource naming.

#### 1a. App secrets (`.env`)

This file holds the Azure AD app registration credentials. The deploy script reads these to seed Key Vault secrets.

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Required: from your Azure AD App Registration
GRAPH_MCP_CLIENT_ID=<your-application-client-id>
GRAPH_MCP_TENANT_ID=<your-directory-tenant-id>
```

#### 1b. Azure resource configuration (`.env.azure.prod`)

This file defines the names and locations of all Azure resources. The Makefile sources it before every deploy command.

```bash
cp .env.azure.example .env.azure.prod
```

Edit `.env.azure.prod`:

```bash
# Environment label — drives default naming for all resources.
# This is the single source of truth. All resource names are derived from it
# unless explicitly overridden below.
AZURE_ENV_LABEL=prod

# Resource Group — all resources are created in this group
AZURE_RESOURCE_GROUP=rg-myproject-prod

# Location — Azure region for all resources
AZURE_LOCATION=eastus

# Container Registry — stores the Docker image
# Must be globally unique, lowercase, alphanumeric only
AZURE_ACR_NAME=myprojectprodacr

# Key Vault — stores GRAPH_MCP_CLIENT_ID and GRAPH_MCP_TENANT_ID as secrets
# Must be globally unique
AZURE_KEY_VAULT_NAME=kvmyprojectprod

# Log Analytics Workspace — aggregates container logs
AZURE_LAW_NAME=law-myproject-prod

# Container Apps Environment — hosts all per-user Container Apps
AZURE_CONTAINERAPPS_ENV=cae-myproject-prod

# Virtual Network — provides network isolation
AZURE_VNET_NAME=vnet-myproject-prod

# Subnet for Container Apps (must be /23 or larger, delegated to Microsoft.App/environments)
AZURE_SUBNET_NAME=snet-containerapps-prod

# Storage Account — Premium FileStorage for NFS
# Must be globally unique, lowercase, alphanumeric only
AZURE_STORAGE_ACCOUNT=myprojectprodst

# NFS storage mount name in the Container Apps Environment
AZURE_NFS_STORAGE_NAME=myproject-nfs-prod
```

Both `.env` and `.env.azure.*` files are gitignored. Only `.env.example` and `.env.azure.example` are tracked.

> **Multiple environments**: Use `ENV=dev` to target a different environment:
>
> ```bash
> cp .env.azure.example .env.azure.dev
> # Edit .env.azure.dev with dev-specific values
> make deploy ENV=dev
> ```

### Step 2: Create Shared Infrastructure

```bash
make deploy
```

This runs `azure.sh init` followed by `azure.sh build`. The `init` command creates all shared infrastructure in order (skipping resources that already exist):

| #   | Resource                                                   | What it does                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Resource Group**                                         | Container for all resources                                                                                                                                                                                                  |
| 2   | **Container Registry** (Basic SKU)                         | Stores Docker images. Admin access disabled — Container Apps pull via managed identity.                                                                                                                                      |
| 3   | **Key Vault** (RBAC mode)                                  | Stores `GRAPH_MCP_CLIENT_ID` and `GRAPH_MCP_TENANT_ID` as secrets. Each Container App's system-assigned managed identity gets `Key Vault Secrets User` role. Your user gets `Key Vault Secrets Officer` for seeding secrets. |
| 4   | **Log Analytics Workspace**                                | Aggregates container logs from all user instances.                                                                                                                                                                           |
| 5   | **Virtual Network** (`10.0.0.0/16`)                        | Network isolation. Required for NFS volume mounts in Container Apps.                                                                                                                                                         |
| 6   | **Subnet** (`10.0.0.0/23`)                                 | Delegated to `Microsoft.App/environments`. Hosts the Container Apps Environment. The `/23` gives ~500 IPs (Azure CAE requires minimum `/23`).                                                                                |
| 7   | **Container Apps Environment**                             | Shared compute environment with `--internal-only true` (no public IP). Connected to the VNet via the delegated subnet.                                                                                                       |
| 8   | **Storage Account** (Premium FileStorage)                  | NFS-capable file storage. Created with `publicNetworkAccess=Disabled`, `allowSharedKeyAccess=false`, `httpsOnly=false`.                                                                                                      |
| 9   | **NFS File Share** (`data`, 100 GiB)                       | The actual NFS share. 100 GiB is the minimum for Premium FileStorage.                                                                                                                                                        |
| 10  | **Private Endpoint Subnet** (`10.0.2.0/24`)                | Separate subnet for the private endpoint (cannot share the CAE subnet).                                                                                                                                                      |
| 11  | **Private Endpoint**                                       | Connects the storage account to the VNet. Required because `publicNetworkAccess=Disabled`.                                                                                                                                   |
| 12  | **Private DNS Zone** (`privatelink.file.core.windows.net`) | Resolves `<account>.file.core.windows.net` to the private endpoint's IP within the VNet.                                                                                                                                     |
| 13  | **DNS Zone VNet Link**                                     | Links the private DNS zone to the VNet so containers can resolve the storage account name.                                                                                                                                   |
| 14  | **DNS Zone Group**                                         | Associates the private endpoint with the DNS zone. Auto-creates the A record.                                                                                                                                                |
| 15  | **CAE Storage Mount**                                      | Mounts the NFS share into the Container Apps Environment as a named volume. Individual containers reference this mount by name.                                                                                              |
| 16  | **Key Vault Secrets**                                      | Seeds `graph-mcp-client-id` and `graph-mcp-tenant-id` from your `.env` file.                                                                                                                                                 |

After `init`, the `build` command compiles the TypeScript source, builds a Docker image via ACR Tasks (cloud build — no local Docker needed), and pushes it to the registry. The image is tagged with both `latest` and the current git short SHA.

### Step 3: Deploy a User

```bash
make add-user U=jdoe
```

This creates a per-user Container App named `ca-graph-mcp-gw-<env>-<user>` (e.g., `ca-graph-mcp-gw-prod-jdoe`). The creation happens in 4 phases:

1. **Create** — Deploys a Container App with a default quickstart image and system-assigned managed identity. At this point the identity doesn't exist yet, so we can't pull from ACR or reference Key Vault secrets.

2. **RBAC** — Grants the new managed identity:
   - `AcrPull` on the Container Registry (to pull images)
   - `Key Vault Secrets User` on the Key Vault (to read secrets at runtime)
   - Waits 30 seconds for AAD role propagation.

3. **Registry** — Configures the Container App to pull from ACR using its managed identity (no admin credentials or access keys).

4. **YAML Update** — Applies the full container spec:
   - Real image from ACR
   - Key Vault secret references for `GRAPH_MCP_CLIENT_ID` and `GRAPH_MCP_TENANT_ID`
   - NFS volume mount at `/app/data`
   - Environment variables (`HOST`, `PORT`, `NODE_ENV`, `USER_SLUG`)
   - Health probes (liveness, readiness, startup)
   - Scale rule: `minReplicas=1`, `maxReplicas=1`

If the Container App already exists, `add-user` skips to phase 4 (YAML update) — this is how you roll out image updates.

On success, the command prints the internal FQDN:

```
✓ ca-graph-mcp-gw-prod-jdoe [prod]
  FQDN:    ca-graph-mcp-gw-prod-jdoe.internal.<env-hash>.<region>.azurecontainerapps.io
  MCP:     https://ca-graph-mcp-gw-prod-jdoe.internal.<env-hash>.<region>.azurecontainerapps.io/mcp
  Health:  https://ca-graph-mcp-gw-prod-jdoe.internal.<env-hash>.<region>.azurecontainerapps.io/health
```

### Step 4: One-Time Login

Each user must authenticate once via device code flow. This acquires a Microsoft Graph token and persists it to the NFS share.

```bash
make login-user U=jdoe
```

This command:

1. Scales the container to 1 replica (if currently at zero)
2. Waits for the replica to be running
3. Runs `node dist/index.js --login-device` inside the container via `az containerapp exec`
4. Displays a device code — go to https://microsoft.com/devicelogin and enter it
5. After successful sign-in, the token is cached at `/app/data/jdoe/graph-mcp/tokens/token-cache.json` on the NFS share
6. Restores scale-to-zero

> **Requires an interactive terminal** — `az containerapp exec` needs a TTY. You cannot run this from a non-interactive script or CI pipeline.

The token persists across container restarts and scale-to-zero cycles because it's stored on the NFS share.

### Step 5: Verify with Smoke Test

```bash
make smoke-user U=jdoe
```

This scales up the container, runs a built-in smoke test suite inside it, and scales back down. The smoke test validates end-to-end functionality across all tool categories:

| #   | Check                | What it tests                                                    |
| --- | -------------------- | ---------------------------------------------------------------- |
| 1   | `health`             | `GET /health` returns status OK and authenticated user           |
| 2   | `tools/list`         | MCP `tools/list` returns all 11 tools                            |
| 3   | `find mail`          | Graph API mail search works                                      |
| 4   | `find events`        | Graph API calendar date-range search works                       |
| 5   | `find files`         | Graph API file search works                                      |
| 6   | `get_file_metadata`  | File metadata retrieval by drive/item ID                         |
| 7   | `get_file_content`   | File content download (text inline or binary base64)             |
| 8   | `get_email`          | Email retrieval by ID                                            |
| 9   | `get_email_thread`   | Conversation thread fetch (by conversation_id and by message_id) |
| 10  | `get_event`          | Calendar event retrieval by ID                                   |
| 11  | `compose_email`      | Draft, send, and reply flows                                     |
| 12  | `schedule_meeting`   | Preview + create meeting with auto free-slot finding             |
| 13  | `respond_to_meeting` | Accept meeting invitation                                        |

Expected output (abbreviated):

```
MCP Gateway — Remote Smoke Test

▸ Health check
  ✓ health
    {"status":"ok","user":"jdoe@example.com"}
▸ tools/list
  ✓ tools/list count = 11
▸ find — mail
  ✓ find mail
▸ find — events
  ✓ find events
▸ find — files
  ✓ find files
  ✓ get_file_metadata ...
  ✓ get_file_content ...
▸ get_email / get_email_thread
  ✓ get_email returned correct ID
  ✓ get_email_thread correct conversation_id
  ✓ get_email_thread (by msg_id) ...
▸ compose_email
  ✓ compose_email draft ...
  ✓ compose_email send ...
▸ schedule_meeting
  ✓ schedule_meeting ...
▸ respond_to_meeting
  ✓ respond_to_meeting accept ...

▸ Results: N passed, 0 failed, 0 warnings
All smoke tests passed!
```

> Like `login-user`, this requires an interactive terminal.

### Step 6: Connect Your AI Agent

Containers default to `minReplicas=1` (always-on). The MCP endpoint is reachable immediately after deployment. Point your AI agent's MCP config to the internal FQDN:

```
https://ca-graph-mcp-gw-prod-jdoe.internal.<env-hash>.<region>.azurecontainerapps.io/mcp
```

**Cost control**: If you want to stop paying for compute during extended absences (vacation, etc.), you can manually scale down and back up:

```bash
# Stop the container (MCP endpoint becomes unreachable)
make scale-down U=jdoe

# Start it again before your next session
make scale-up U=jdoe
```

At 0.25 vCPU / 0.5 GiB, always-on costs approximately $15-20/month per user.

`scale-up` waits for a running replica and prints the FQDN. `scale-down` sets `minReplicas=0` — the container stops when idle.

Point your AI agent's MCP config to the internal FQDN:

```
https://ca-graph-mcp-gw-prod-jdoe.internal.<env-hash>.<region>.azurecontainerapps.io/mcp
```

### Managing Users

```bash
# Add more users
make add-user U=alice
make login-user U=alice

# Deploy multiple users at once
# (run add-user for each — the script accepts multiple users)
# bash: set -a; . ./.env.azure.prod; set +a; bash scripts/azure.sh add alice bob carol

# Remove a user (deletes the Container App; NFS data is preserved)
make remove-user U=jdoe

# Check status of all users
make deploy-status

# Check status of a specific user
make deploy-status U=jdoe

# Tail logs
make deploy-logs U=jdoe

# Dry-run: see what exists and what's missing
make deploy-plan
```

### Updating the Application

After code changes, rebuild the image and update each user's Container App:

```bash
# 1. Build and push new image to ACR
make deploy   # or: set -a; . ./.env.azure.prod; set +a; bash scripts/azure.sh build

# 2. Update each user (pulls the new image, reapplies the full YAML spec)
make add-user U=jdoe
make add-user U=alice

# 3. Verify
make smoke-user U=jdoe
```

`add-user` on an existing Container App is an update — it reapplies the YAML spec with `image: latest`, triggering a new revision.

### Environment Variable Reference

All variables have defaults derived from `AZURE_ENV_LABEL`. Only override what you need to change.

| Variable                  | Default (when `ENV_LABEL=prod`) | Description                                          |
| ------------------------- | ------------------------------- | ---------------------------------------------------- |
| `AZURE_ENV_LABEL`         | `dev`                           | Environment name. Drives all default resource names. |
| `AZURE_RESOURCE_GROUP`    | `rg-graph-mcp-{env}`            | Resource group name                                  |
| `AZURE_LOCATION`          | `eastus`                        | Azure region                                         |
| `AZURE_ACR_NAME`          | `graphmcp{env}acr`              | Container Registry name                              |
| `AZURE_KEY_VAULT_NAME`    | `kvgraphmcp{env}`               | Key Vault name                                       |
| `AZURE_LAW_NAME`          | `law-graph-mcp-{env}`           | Log Analytics Workspace name                         |
| `AZURE_CONTAINERAPPS_ENV` | `cae-graph-mcp-{env}`           | Container Apps Environment name                      |
| `AZURE_VNET_NAME`         | `vnet-graph-mcp-{env}`          | Virtual Network name                                 |
| `AZURE_SUBNET_NAME`       | `snet-containerapps-{env}`      | CAE subnet name                                      |
| `AZURE_STORAGE_ACCOUNT`   | `graphmcp{env}st`               | Storage Account name                                 |
| `AZURE_NFS_STORAGE_NAME`  | `graph-mcp-nfs-{env}`           | CAE storage mount name                               |

**Derived (not configurable):**

| Name         | Value                   | Description                                                           |
| ------------ | ----------------------- | --------------------------------------------------------------------- |
| `APP_PREFIX` | `ca-graph-mcp-gw-{env}` | Container App name prefix. User apps are named `{APP_PREFIX}-{user}`. |

Container App names have a 32-character limit. With the prefix `ca-graph-mcp-gw-prod-`, usernames can be up to 12 characters.

### Teardown

```bash
# Delete everything — resource group and all resources in it
make deploy-destroy

# Delete only CAE + Log Analytics (preserves ACR, Key Vault, Storage)
set -a; . ./.env.azure.prod; set +a; bash scripts/azure.sh destroy-infra
```

`deploy-destroy` prompts for confirmation by requiring you to type the resource group name.

### Architecture Notes

#### NFS Storage — Why It Works Without Shared Keys

The storage account is created with `allowSharedKeyAccess=false` and `publicNetworkAccess=Disabled`. This is compatible with NFS because:

- **NFS uses network-level authentication** (`sec=sys`), not storage account keys. The Container Apps Environment mounts the share via `--storage-type NfsAzureFile` which doesn't use `--access-key` at all.
- **Access is controlled by the private endpoint** — only resources in the VNet can reach the storage account.
- This is different from SMB (`AzureFile`) mounts, which require `allowSharedKeyAccess=true` because they authenticate with the storage account key.

| Mount Type           | Auth Mechanism      | Needs `allowSharedKeyAccess=true`? |
| -------------------- | ------------------- | ---------------------------------- |
| `NfsAzureFile` (NFS) | Network/VNet        | No                                 |
| `AzureFile` (SMB)    | Storage account key | Yes                                |

NFS has specific requirements:

- **Premium FileStorage** account (`--sku Premium_LRS --kind FileStorage`)
- **100 GiB minimum** quota (Azure Files NFS floor)
- **`httpsOnly=false`** — NFS protocol does not support HTTPS
- **Private endpoint** required when `publicNetworkAccess=Disabled`
- **Dedicated subnet** for the CAE (delegated to `Microsoft.App/environments`, minimum `/23`)

#### Internal-Only Container Apps Environment

The CAE is created with `--internal-only true`, meaning:

- No public IP is allocated
- Container Apps are only reachable from within the VNet
- The FQDN uses the `.internal.` subdomain
- AI agents accessing the MCP endpoint must be on the same network (or use a VPN/private link)

#### Always-On Default

Containers are deployed with `minReplicas=1` (always-on) so the MCP endpoint is always reachable:

- **Always reachable**: AI agents can call the MCP endpoint at any time without cold start delays
- **Tokens persist**: stored on the NFS share, survive container restarts
- **Cost**: ~$15-20/month per user at 0.25 vCPU / 0.5 GiB
- **Manual scale-down available**: `make scale-down U=jdoe` sets `minReplicas=0` for cost savings during extended absences. `make scale-up U=jdoe` brings it back.

#### Container Entrypoint

The Docker image starts as root to create user-specific directories on the NFS share (`/app/data/<user>/graph-mcp/tokens/` and `/app/data/<user>/graph-mcp/audit/`), then drops to the unprivileged `node` user via `gosu`. This is handled by `scripts/entrypoint.sh`.

#### The `make` and `azure.sh` Relationship

The Makefile provides two layers of deploy targets:

- **Deploy targets** (`make deploy`, `make add-user U=x`, etc.) — source `.env.azure.$(ENV)` before calling `azure.sh`. Use these for normal operations.
- **Azure targets** (`make azure-init`, `make azure-add U=x`, etc.) — call `azure.sh` directly without sourcing any env file. Use these when you've already exported env vars or want to use the script defaults.

The `azure.sh` script is fully idempotent — every resource creation is guarded by an existence check. Safe to re-run at any time.

---

## Project Structure

```
src/
  auth/         MSAL login, token cache, Graph client
  config/       YAML config loader with Zod validation
  graph/        Graph API modules (calendar, files, mail)
  mcp/          HTTP + stdio MCP JSON-RPC server
  tools/        MCP tool definitions (find, get, compose-email, etc.)
  utils/        Helpers, audit logger, types, structured logging, smoke test
  public/       Web auth UI
  index.ts      Entry point (--smoke, --login-device, --user, --stdio flags)
scripts/
  azure.sh      Full Azure lifecycle (init, build, add, remove, login, scale, smoke, destroy)
  entrypoint.sh Container entrypoint (NFS dir setup + gosu drop)
  test-all-tools.sh  Local smoke test (all tools including writes)
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
