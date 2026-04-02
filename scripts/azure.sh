#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# azure.sh — Full Azure lifecycle for graph-mcp-gateway
#
# Manages shared infrastructure (init/destroy) and per-user Container App
# instances (add/remove/login). Fully idempotent — safe to re-run.
#
# Usage:
#   ./scripts/azure.sh init                     Create shared infra
#   ./scripts/azure.sh plan                     Dry-run: show what exists / missing
#   ./scripts/azure.sh build [tag]              Build image in ACR
#   ./scripts/azure.sh secrets                  Seed Key Vault from .env
#   ./scripts/azure.sh add <user> [user...]     Deploy per-user Container Apps
#   ./scripts/azure.sh remove <user> [user...]  Remove per-user instances
#   ./scripts/azure.sh login <user>             Device-code MSAL auth
#   ./scripts/azure.sh smoke <user>             Remote smoke test
#   ./scripts/azure.sh status [user]            Show deployment status
#   ./scripts/azure.sh logs <user>              Tail container logs
#   ./scripts/azure.sh destroy                  Tear down EVERYTHING (shared + users)
#   ./scripts/azure.sh destroy-infra            Tear down shared infra only
#
# Environment overrides (all have defaults keyed off AZURE_ENV_LABEL):
#   AZURE_ENV_LABEL              Environment name (dev, staging, prod)
#   AZURE_RESOURCE_GROUP         AZURE_CONTAINERAPPS_ENV
#   AZURE_ACR_NAME               AZURE_KEY_VAULT_NAME
#   AZURE_LAW_NAME               AZURE_LOCATION
#   AZURE_STORAGE_ACCOUNT        AZURE_NFS_STORAGE_NAME
#   AZURE_VNET_NAME              AZURE_SUBNET_NAME
#   AZURE_IMAGE_NAME             AZURE_APP_PREFIX
# ──────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Environment label (dev, staging, prod) ────────────────────────────────
ENV_LABEL="${AZURE_ENV_LABEL:-dev}"

# ── Shared resource names (override via env vars) ────────────────────────────
RG="${AZURE_RESOURCE_GROUP:-rg-graph-mcp-${ENV_LABEL}}"
CAE="${AZURE_CONTAINERAPPS_ENV:-cae-graph-mcp-${ENV_LABEL}}"
ACR="${AZURE_ACR_NAME:-graphmcp${ENV_LABEL}acr}"
KV="${AZURE_KEY_VAULT_NAME:-kvgraphmcp${ENV_LABEL}}"
LOCATION="${AZURE_LOCATION:-eastus}"
LAW="${AZURE_LAW_NAME:-law-graph-mcp-${ENV_LABEL}}"
STORAGE_ACCOUNT="${AZURE_STORAGE_ACCOUNT:-graphmcp${ENV_LABEL}st}"
NFS_STORAGE_NAME="${AZURE_NFS_STORAGE_NAME:-graph-mcp-nfs-${ENV_LABEL}}"
VNET_NAME="${AZURE_VNET_NAME:-vnet-graph-mcp-${ENV_LABEL}}"
SUBNET_NAME="${AZURE_SUBNET_NAME:-snet-containerapps-${ENV_LABEL}}"

# ── Naming conventions (overridable via env vars) ────────────────────────
IMAGE_NAME="${AZURE_IMAGE_NAME:-graph-mcp-gateway}"
APP_PREFIX="${AZURE_APP_PREFIX:-ca-graph-mcp-gw-${ENV_LABEL}}"  # → ca-graph-mcp-gw-prod-jdoe

# ── Key Vault secret names ───────────────────────────────────────────────────
KV_SECRET_CLIENT_ID="graph-mcp-client-id"
KV_SECRET_TENANT_ID="graph-mcp-tenant-id"
KV_SECRET_ALLOW_DOMAINS="graph-mcp-allow-domains"
KV_SECRET_ENCRYPTION_KEY="graph-mcp-encryption-key"

# ── Helpers ──────────────────────────────────────────────────────────────────

log()    { printf '\033[0;36m▸ %s\033[0m\n' "$*"; }
ok()     { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
warn()   { printf '\033[0;33m⚠ %s\033[0m\n' "$*"; }
err()    { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; }
die()    { err "$@"; exit 1; }
exists() { printf '\033[0;32m  ✓ exists\033[0m  %s\n' "$*"; }
missing(){ printf '\033[0;33m  ✗ missing\033[0m %s\n' "$*"; }

# Portable timeout — prefers GNU timeout/gtimeout, falls back to a perl shim
if command -v timeout >/dev/null 2>&1; then
  _timeout() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
  _timeout() { gtimeout "$@"; }
else
  # Pure-bash fallback: _timeout <seconds> <cmd…>
  _timeout() {
    local secs="$1"; shift
    "$@" &
    local pid=$!
    ( sleep "$secs"; kill "$pid" 2>/dev/null ) &
    local watchdog=$!
    wait "$pid" 2>/dev/null
    local rc=$?
    kill "$watchdog" 2>/dev/null
    wait "$watchdog" 2>/dev/null
    # If the process was killed by our watchdog, mimic GNU timeout exit code 124
    if [ $rc -gt 128 ]; then rc=124; fi
    return $rc
  }
fi

validate_user() {
  local u="$1"
  if [[ ! "$u" =~ ^[a-z0-9][a-z0-9-]{0,19}$ ]]; then
    die "Invalid user name '$u'. Must be 1-20 chars, lowercase alphanumeric + hyphens."
  fi
  local app_name="${APP_PREFIX}-${u}"
  if [ ${#app_name} -gt 32 ]; then
    die "Container App name '${app_name}' exceeds 32 chars. Use a shorter user name."
  fi
}

require_az() {
  command -v az >/dev/null 2>&1 || die "Azure CLI required. Install: https://aka.ms/installazurecli"
  log "Verifying Azure CLI session …"
  if ! az account show >/dev/null 2>&1; then
    err "Azure CLI session expired or not logged in."
    die "Run:  az login"
  fi
}

# Check if a resource exists (returns 0=exists, 1=missing)
resource_exists() {
  eval "$1" >/dev/null 2>&1
}

# Cached lookups
_acr_server=""
acr_server() {
  if [ -z "$_acr_server" ]; then
    _acr_server=$(az acr show --name "$ACR" --resource-group "$RG" --query loginServer -o tsv 2>/dev/null || echo "")
  fi
  echo "$_acr_server"
}

# ═════════════════════════════════════════════════════════════════════════════
# PLAN — dry-run showing what exists and what's missing
# ═════════════════════════════════════════════════════════════════════════════

cmd_plan() {
  require_az
  echo ""
  log "Azure deployment plan for graph-mcp-gateway [${ENV_LABEL}]"
  log "Location: ${LOCATION}"
  echo ""

  echo "── Shared Infrastructure ──────────────────────────────────"
  check_resource "Resource Group:            ${RG}" \
    "az group show --name '$RG'"
  check_resource "Container Registry:        ${ACR}" \
    "az acr show --name '$ACR' --resource-group '$RG'"
  check_resource "Key Vault:                 ${KV}" \
    "az keyvault show --name '$KV' --resource-group '$RG'"
  check_resource "Log Analytics:             ${LAW}" \
    "az monitor log-analytics workspace show --workspace-name '$LAW' --resource-group '$RG'"
  check_resource "VNet:                      ${VNET_NAME}" \
    "az network vnet show --name '$VNET_NAME' --resource-group '$RG'"
  check_resource "Subnet:                    ${SUBNET_NAME}" \
    "az network vnet subnet show --vnet-name '$VNET_NAME' --resource-group '$RG' --name '$SUBNET_NAME'"
  check_resource "Container Apps Env:        ${CAE}" \
    "az containerapp env show --name '$CAE' --resource-group '$RG'"
  check_resource "Storage Account:           ${STORAGE_ACCOUNT}" \
    "az storage account show --name '$STORAGE_ACCOUNT' --resource-group '$RG'"
  check_resource "NFS Share:                 data" \
    "az storage share-rm show --storage-account '$STORAGE_ACCOUNT' --resource-group '$RG' --name data"
  check_resource "Private Endpoint:          pe-${STORAGE_ACCOUNT}" \
    "az network private-endpoint show --name 'pe-${STORAGE_ACCOUNT}' --resource-group '$RG'"
  check_resource "Private DNS Zone:          privatelink.file.core.windows.net" \
    "az network private-dns zone show --name 'privatelink.file.core.windows.net' --resource-group '$RG'"
  check_resource "CAE Storage Mount:         ${NFS_STORAGE_NAME}" \
    "az containerapp env storage show --name '$CAE' --resource-group '$RG' --storage-name '$NFS_STORAGE_NAME'"
  echo ""

  echo "── Key Vault Secrets ──────────────────────────────────────"
  check_resource "Secret: ${KV_SECRET_CLIENT_ID}" \
    "az keyvault secret show --vault-name '$KV' --name '$KV_SECRET_CLIENT_ID'"
  check_resource "Secret: ${KV_SECRET_TENANT_ID}" \
    "az keyvault secret show --vault-name '$KV' --name '$KV_SECRET_TENANT_ID'"
  check_resource "Secret: ${KV_SECRET_ALLOW_DOMAINS}" \
    "az keyvault secret show --vault-name '$KV' --name '$KV_SECRET_ALLOW_DOMAINS'"
  check_resource "Secret: ${KV_SECRET_ENCRYPTION_KEY}" \
    "az keyvault secret show --vault-name '$KV' --name '$KV_SECRET_ENCRYPTION_KEY'"
  echo ""

  echo "── Container Image ────────────────────────────────────────"
  check_resource "ACR Image: ${IMAGE_NAME}" \
    "az acr repository show --name '$ACR' --repository '$IMAGE_NAME'"
  echo ""

  echo "── User Container Apps ────────────────────────────────────"
  local found=false
  local apps
  apps=$(az containerapp list --resource-group "$RG" \
    --query "[?starts_with(name, '${APP_PREFIX}-')].name" -o tsv 2>/dev/null || echo "")
  if [ -n "$apps" ]; then
    while IFS= read -r app; do
      local user="${app#${APP_PREFIX}-}"
      local fqdn
      fqdn=$(az containerapp show --name "$app" --resource-group "$RG" \
        --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null || echo "<none>")
      local replicas
      replicas=$(az containerapp show --name "$app" --resource-group "$RG" \
        --query "properties.runningStatus.replicas" -o tsv 2>/dev/null || echo "0")
      exists "${app}  replicas=${replicas}  fqdn=${fqdn}"
      found=true
    done <<< "$apps"
  fi
  if [ "$found" = false ]; then
    missing "No user Container Apps found"
  fi
  echo ""
}

check_resource() {
  local label="$1" cmd="$2"
  if resource_exists "$cmd"; then
    exists "$label"
  else
    missing "$label"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
# INIT — create all shared infrastructure (idempotent)
# ═════════════════════════════════════════════════════════════════════════════

cmd_init() {
  require_az
  echo ""
  log "═══ Initializing shared infrastructure [${ENV_LABEL}] ═══"
  log "Location: ${LOCATION}   Resource Group: ${RG}   Storage: ${STORAGE_ACCOUNT}"
  echo ""

  # 1. Resource Group
  if resource_exists "az group show --name '$RG'"; then
    ok "Resource Group '${RG}' exists"
  else
    log "Creating Resource Group '${RG}' ..."
    az group create --name "$RG" --location "$LOCATION" --output none
    ok "Resource Group '${RG}' created"
  fi

  # 2. Container Registry
  if resource_exists "az acr show --name '$ACR' --resource-group '$RG'"; then
    ok "Container Registry '${ACR}' exists"
  else
    log "Creating Container Registry '${ACR}' (Basic SKU) ..."
    az acr create \
      --name "$ACR" \
      --resource-group "$RG" \
      --location "$LOCATION" \
      --sku Basic \
      --admin-enabled false \
      --output none
    ok "Container Registry '${ACR}' created"
  fi

  # 3. Key Vault (RBAC authorization — required for managed identity secret refs)
  if resource_exists "az keyvault show --name '$KV' --resource-group '$RG'"; then
    ok "Key Vault '${KV}' exists"
  else
    log "Creating Key Vault '${KV}' (RBAC mode) ..."
    az keyvault create \
      --name "$KV" \
      --resource-group "$RG" \
      --location "$LOCATION" \
      --enable-rbac-authorization true \
      --output none
    ok "Key Vault '${KV}' created"
  fi

  # Grant current user Key Vault Secrets Officer (idempotent)
  local my_oid
  my_oid=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
  if [ -n "$my_oid" ]; then
    local kv_id
    kv_id=$(az keyvault show --name "$KV" --resource-group "$RG" --query id -o tsv)
    if az role assignment list --assignee "$my_oid" --role "Key Vault Secrets Officer" --scope "$kv_id" \
      --query '[0].id' -o tsv 2>/dev/null | grep -q .; then
      ok "Key Vault Secrets Officer role already assigned to you"
    else
      log "Granting you Key Vault Secrets Officer ..."
      az role assignment create \
        --assignee "$my_oid" \
        --role "Key Vault Secrets Officer" \
        --scope "$kv_id" \
        --output none
      ok "Key Vault Secrets Officer role granted"
    fi
  fi

  # 4. Log Analytics Workspace
  if resource_exists "az monitor log-analytics workspace show --workspace-name '$LAW' --resource-group '$RG'"; then
    ok "Log Analytics '${LAW}' exists"
  else
    log "Creating Log Analytics Workspace '${LAW}' ..."
    az monitor log-analytics workspace create \
      --workspace-name "$LAW" \
      --resource-group "$RG" \
      --location "$LOCATION" \
      --output none
    ok "Log Analytics '${LAW}' created"
  fi

  # 5. Virtual Network + Subnet (required for NFS volume mounts in CAE)
  if resource_exists "az network vnet show --name '$VNET_NAME' --resource-group '$RG'"; then
    ok "VNet '${VNET_NAME}' exists"
  else
    log "Creating VNet '${VNET_NAME}' with subnet '${SUBNET_NAME}' ..."
    az network vnet create \
      --name "$VNET_NAME" \
      --resource-group "$RG" \
      --location "$LOCATION" \
      --address-prefix 10.0.0.0/16 \
      --output none
    ok "VNet '${VNET_NAME}' created"
  fi

  if resource_exists "az network vnet subnet show --vnet-name '$VNET_NAME' --resource-group '$RG' --name '$SUBNET_NAME'"; then
    ok "Subnet '${SUBNET_NAME}' exists"
  else
    log "Creating subnet '${SUBNET_NAME}' (/23 for Container Apps) ..."
    az network vnet subnet create \
      --name "$SUBNET_NAME" \
      --vnet-name "$VNET_NAME" \
      --resource-group "$RG" \
      --address-prefix 10.0.0.0/23 \
      --delegations Microsoft.App/environments \
      --output none
    ok "Subnet '${SUBNET_NAME}' created"
  fi

  # 6. Container Apps Environment (with custom VNet for NFS support)
  if resource_exists "az containerapp env show --name '$CAE' --resource-group '$RG'"; then
    ok "Container Apps Environment '${CAE}' exists"
  else
    log "Creating Container Apps Environment '${CAE}' (custom VNet) ..."
    local law_id law_key subnet_id
    law_id=$(az monitor log-analytics workspace show \
      --workspace-name "$LAW" --resource-group "$RG" \
      --query customerId -o tsv)
    law_key=$(az monitor log-analytics workspace get-shared-keys \
      --workspace-name "$LAW" --resource-group "$RG" \
      --query primarySharedKey -o tsv)
    subnet_id=$(az network vnet subnet show \
      --name "$SUBNET_NAME" --vnet-name "$VNET_NAME" --resource-group "$RG" \
      --query id -o tsv)

    az containerapp env create \
      --name "$CAE" \
      --resource-group "$RG" \
      --location "$LOCATION" \
      --logs-workspace-id "$law_id" \
      --logs-workspace-key "$law_key" \
      --infrastructure-subnet-resource-id "$subnet_id" \
      --internal-only true \
      --output none
    ok "Container Apps Environment '${CAE}' created"
  fi

  # 7. NFS Storage Account (Premium FileStorage — required for NFS protocol)
  if resource_exists "az storage account show --name '$STORAGE_ACCOUNT' --resource-group '$RG'"; then
    ok "Storage Account '${STORAGE_ACCOUNT}' exists"
  else
    log "Creating Storage Account '${STORAGE_ACCOUNT}' (Premium FileStorage) ..."
    az storage account create \
      --name "$STORAGE_ACCOUNT" \
      --resource-group "$RG" \
      --location "$LOCATION" \
      --sku Premium_LRS \
      --kind FileStorage \
      --enable-large-file-share \
      --public-network-access Disabled \
      --allow-shared-key-access false \
      --https-only false \
      --output none
    ok "Storage Account '${STORAGE_ACCOUNT}' created"
  fi

  # 8. NFS File Share
  if resource_exists "az storage share-rm show --storage-account '$STORAGE_ACCOUNT' --resource-group '$RG' --name data"; then
    ok "NFS share 'data' exists"
  else
    log "Creating NFS file share 'data' (100 GiB) ..."
    az storage share-rm create \
      --storage-account "$STORAGE_ACCOUNT" \
      --resource-group "$RG" \
      --name data \
      --enabled-protocols NFS \
      --quota 100 \
      --output none
    ok "NFS share 'data' created"
  fi

  # 9. Private Endpoint for NFS storage (required when public-network-access is Disabled)
  local pe_subnet="snet-privateendpoints-${ENV_LABEL}"
  local pe_name="pe-${STORAGE_ACCOUNT}"

  if resource_exists "az network vnet subnet show --vnet-name '$VNET_NAME' --resource-group '$RG' --name '$pe_subnet'"; then
    ok "Private endpoint subnet '${pe_subnet}' exists"
  else
    log "Creating private endpoint subnet '${pe_subnet}' ..."
    az network vnet subnet create \
      --name "$pe_subnet" \
      --vnet-name "$VNET_NAME" \
      --resource-group "$RG" \
      --address-prefix 10.0.2.0/24 \
      --output none
    ok "Subnet '${pe_subnet}' created"
  fi

  if resource_exists "az network private-endpoint show --name '$pe_name' --resource-group '$RG'"; then
    ok "Private endpoint '${pe_name}' exists"
  else
    log "Creating private endpoint '${pe_name}' for storage account ..."
    local storage_id
    storage_id=$(az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RG" --query id -o tsv)
    az network private-endpoint create \
      --name "$pe_name" \
      --resource-group "$RG" \
      --vnet-name "$VNET_NAME" \
      --subnet "$pe_subnet" \
      --private-connection-resource-id "$storage_id" \
      --group-id file \
      --connection-name "${pe_name}-conn" \
      --output none
    ok "Private endpoint '${pe_name}' created"
  fi

  # Private DNS zone for file.core.windows.net
  local dns_zone="privatelink.file.core.windows.net"
  if resource_exists "az network private-dns zone show --name '$dns_zone' --resource-group '$RG'"; then
    ok "Private DNS zone '${dns_zone}' exists"
  else
    log "Creating private DNS zone '${dns_zone}' ..."
    az network private-dns zone create \
      --name "$dns_zone" \
      --resource-group "$RG" \
      --output none
    ok "Private DNS zone '${dns_zone}' created"
  fi

  # Link DNS zone to VNet
  local dns_link="link-${VNET_NAME}"
  if resource_exists "az network private-dns link vnet show --zone-name '$dns_zone' --resource-group '$RG' --name '$dns_link'"; then
    ok "DNS zone VNet link '${dns_link}' exists"
  else
    log "Linking DNS zone to VNet ..."
    az network private-dns link vnet create \
      --zone-name "$dns_zone" \
      --resource-group "$RG" \
      --name "$dns_link" \
      --virtual-network "$VNET_NAME" \
      --registration-enabled false \
      --output none
    ok "DNS zone linked to VNet"
  fi

  # DNS zone group on private endpoint (auto-creates A record)
  # NOTE: `dns-zone-group show` returns {} with exit 0 even when empty,
  # so we use `list` and check for non-empty array instead.
  local dns_group="default"
  local zg_count
  zg_count=$(az network private-endpoint dns-zone-group list \
    --endpoint-name "$pe_name" --resource-group "$RG" \
    --query "length(@)" -o tsv 2>/dev/null || echo "0")
  if [ "${zg_count:-0}" -gt 0 ]; then
    ok "DNS zone group on '${pe_name}' exists"
  else
    log "Configuring DNS zone group on private endpoint ..."
    az network private-endpoint dns-zone-group create \
      --endpoint-name "$pe_name" \
      --resource-group "$RG" \
      --name "$dns_group" \
      --private-dns-zone "$dns_zone" \
      --zone-name "file" \
      --output none
    ok "DNS zone group configured"
  fi

  # 10. Mount NFS share to Container Apps Environment
  if resource_exists "az containerapp env storage show --name '$CAE' --resource-group '$RG' --storage-name '$NFS_STORAGE_NAME'"; then
    ok "CAE storage mount '${NFS_STORAGE_NAME}' exists"
  else
    log "Mounting NFS share to Container Apps Environment as '${NFS_STORAGE_NAME}' ..."
    az containerapp env storage set \
      --name "$CAE" \
      --resource-group "$RG" \
      --storage-name "$NFS_STORAGE_NAME" \
      --storage-type NfsAzureFile \
      --server "${STORAGE_ACCOUNT}.file.core.windows.net" \
      --file-share "/${STORAGE_ACCOUNT}/data" \
      --access-mode ReadWrite \
      --output none
    ok "NFS share mounted as '${NFS_STORAGE_NAME}'"
  fi

  # 9. Seed secrets from .env
  echo ""
  log "Seeding Key Vault secrets ..."
  cmd_secrets

  echo ""
  ok "Shared infrastructure ready"
  log "Next: ./scripts/azure.sh build && ./scripts/azure.sh add <user>"
}

# ═════════════════════════════════════════════════════════════════════════════
# BUILD — build and push image to ACR
# ═════════════════════════════════════════════════════════════════════════════

cmd_build() {
  local tag="${1:-latest}"
  local git_sha
  git_sha=$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo "dev")

  require_az

  if ! resource_exists "az acr show --name '$ACR' --resource-group '$RG'"; then
    die "ACR '${ACR}' not found. Run: $0 init"
  fi

  local server
  server=$(acr_server)

  log "Building image in ACR: ${server}/${IMAGE_NAME}:${tag}"
  az acr build \
    --registry "$ACR" \
    --resource-group "$RG" \
    --image "${IMAGE_NAME}:${tag}" \
    --image "${IMAGE_NAME}:${git_sha}" \
    --file Dockerfile \
    "$PROJECT_DIR"

  ok "Image pushed: ${server}/${IMAGE_NAME}:${tag}  (also: ${git_sha})"
}

# ═════════════════════════════════════════════════════════════════════════════
# SECRETS — seed Key Vault from .env
# ═════════════════════════════════════════════════════════════════════════════

cmd_secrets() {
  require_az

  if ! resource_exists "az keyvault show --name '$KV' --resource-group '$RG'"; then
    die "Key Vault '${KV}' not found. Run: $0 init"
  fi

  # Source .env
  local env_file="${PROJECT_DIR}/.env"
  if [ -f "$env_file" ]; then
    # shellcheck disable=SC1090
    set -a; source "$env_file"; set +a
  fi

  local client_id="${GRAPH_MCP_CLIENT_ID:-}"
  local tenant_id="${GRAPH_MCP_TENANT_ID:-}"
  [ -z "$client_id" ] && die "GRAPH_MCP_CLIENT_ID not set. Provide in .env or environment."
  [ -z "$tenant_id" ] && die "GRAPH_MCP_TENANT_ID not set. Provide in .env or environment."

  for pair in "${KV_SECRET_CLIENT_ID}:${client_id}" "${KV_SECRET_TENANT_ID}:${tenant_id}"; do
    local name="${pair%%:*}"
    local value="${pair#*:}"
    local existing
    existing=$(az keyvault secret show --vault-name "$KV" --name "$name" \
      --query value -o tsv 2>/dev/null || echo "")
    if [ "$existing" = "$value" ]; then
      ok "Secret '${name}' unchanged"
    else
      az keyvault secret set --vault-name "$KV" --name "$name" --value "$value" --output none
      ok "Secret '${name}' set"
    fi
  done

  # Auto-generate token cache encryption key if not already in KV
  local enc_existing
  enc_existing=$(az keyvault secret show --vault-name "$KV" --name "$KV_SECRET_ENCRYPTION_KEY" \
    --query value -o tsv 2>/dev/null || echo "")
  if [ -n "$enc_existing" ]; then
    ok "Secret '${KV_SECRET_ENCRYPTION_KEY}' exists (not overwritten)"
  else
    log "Generating token cache encryption key (AES-256, 32 bytes) ..."
    local enc_key
    enc_key=$(openssl rand -base64 32)
    az keyvault secret set --vault-name "$KV" --name "$KV_SECRET_ENCRYPTION_KEY" \
      --value "$enc_key" --output none
    ok "Secret '${KV_SECRET_ENCRYPTION_KEY}' generated and stored"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
# ADD — deploy per-user Container App instances
# ═════════════════════════════════════════════════════════════════════════════

cmd_add() {
  [ $# -eq 0 ] && die "Usage: $0 add <user> [user...]"
  require_az

  # Pre-flight: verify shared infra
  for check in \
    "az group show --name '$RG'" \
    "az containerapp env show --name '$CAE' --resource-group '$RG'" \
    "az acr show --name '$ACR' --resource-group '$RG'" \
    "az keyvault show --name '$KV' --resource-group '$RG'" \
    "az containerapp env storage show --name '$CAE' --resource-group '$RG' --storage-name '$NFS_STORAGE_NAME'"; do
    if ! resource_exists "$check"; then
      die "Shared infrastructure incomplete. Run: $0 init"
    fi
  done

  # Verify KV secrets
  for s in "$KV_SECRET_CLIENT_ID" "$KV_SECRET_TENANT_ID" "$KV_SECRET_ALLOW_DOMAINS" "$KV_SECRET_ENCRYPTION_KEY"; do
    if ! resource_exists "az keyvault secret show --vault-name '$KV' --name '$s'"; then
      die "Secret '${s}' missing. Run: $0 secrets"
    fi
  done

  # Verify image
  if ! resource_exists "az acr repository show --name '$ACR' --repository '$IMAGE_NAME'"; then
    die "Image '${IMAGE_NAME}' not in ACR. Run: $0 build"
  fi

  local server
  server=$(acr_server)

  # Resolve the image tag — use the short git SHA so each deploy creates a
  # genuinely new revision (`:latest` is ignored by ACA if the tag string is
  # unchanged from the previous revision).
  local tag
  tag=$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo "latest")

  # Verify that the pinned tag exists in ACR (cmd_build pushes both :latest
  # and :<sha>).  Fall back to :latest if not found.
  if [ "$tag" != "latest" ]; then
    if ! az acr repository show-tags --name "$ACR" --repository "$IMAGE_NAME" \
         --query "contains(@, '${tag}')" -o tsv 2>/dev/null | grep -qi true; then
      warn "Tag '${tag}' not in ACR — falling back to :latest"
      tag="latest"
    fi
  fi

  log "Image tag: ${tag}"

  for user in "$@"; do
    validate_user "$user"
    deploy_user "$user" "$server" "$tag"
  done

  echo ""
  ok "Done. For each new user, run:  $0 login <user>"
}

deploy_user() {
  local user="$1" server="$2" tag="${3:-latest}"
  local app_name="${APP_PREFIX}-${user}"

  echo ""
  log "═══ ${app_name} [${ENV_LABEL}] ═══"

  # Verify per-user KV secret for identity binding
  local oid_secret="${user}-graph-mcp-object-id"
  if ! resource_exists "az keyvault secret show --vault-name '$KV' --name '${oid_secret}'"; then
    die "Secret '${oid_secret}' missing from Key Vault. Create it with the user's Entra object ID before deploying."
  fi

  # Container App
  if resource_exists "az containerapp show --name '$app_name' --resource-group '$RG'"; then
    log "Container App exists — updating ..."
    update_user "$user" "$server" "$tag"
  else
    log "Creating Container App ..."
    create_user "$user" "$server" "$tag"
  fi
}

create_user() {
  local user="$1" server="$2" tag="${3:-latest}"
  local app_name="${APP_PREFIX}-${user}"

  # Phase 1: create with default quickstart image (identity doesn't exist yet,
  # so we can't pull from ACR or reference Key Vault secrets)
  az containerapp create \
    --name "$app_name" \
    --resource-group "$RG" \
    --environment "$CAE" \
    --system-assigned \
    --target-port 3000 \
    --ingress internal \
    --transport http \
    --min-replicas 1 --max-replicas 1 \
    --cpu 0.25 --memory 0.5Gi \
    --env-vars \
      "HOST=0.0.0.0" \
      "NODE_ENV=production" \
      "PORT=3000" \
    --output none
  ok "Container App created (phase 1 — quickstart image)"

  # Phase 2: RBAC for managed identity
  local principal_id
  principal_id=$(az containerapp identity show \
    --name "$app_name" --resource-group "$RG" --query principalId -o tsv)
  log "Identity: ${principal_id}"

  local acr_id kv_id
  acr_id=$(az acr show --name "$ACR" --resource-group "$RG" --query id -o tsv)
  kv_id=$(az keyvault show --name "$KV" --resource-group "$RG" --query id -o tsv)

  grant_role "$principal_id" "AcrPull" "$acr_id"
  grant_role "$principal_id" "Key Vault Secrets User" "$kv_id"

  log "Waiting 30s for AAD role propagation ..."
  sleep 30

  # Phase 3: set registry to managed-identity pull (must happen before YAML
  # update so the platform can pull the real image)
  az containerapp registry set \
    --name "$app_name" --resource-group "$RG" \
    --server "$server" --identity system \
    --output none
  ok "Registry set to managed-identity pull"

  # Phase 4: apply full spec — real image, KV secrets, NFS volume, probes
  apply_yaml "$user" "$server" "$tag"

  print_result "$app_name"
}

update_user() {
  local user="$1" server="$2" tag="${3:-latest}"
  local app_name="${APP_PREFIX}-${user}"

  # Ensure registry is set before YAML update (so image can be pulled)
  az containerapp registry set \
    --name "$app_name" --resource-group "$RG" \
    --server "$server" --identity system \
    --output none 2>/dev/null || true

  apply_yaml "$user" "$server" "$tag"

  print_result "$app_name"
}

grant_role() {
  local principal="$1" role="$2" scope="$3"
  if az role assignment list --assignee "$principal" --role "$role" --scope "$scope" \
    --query '[0].id' -o tsv 2>/dev/null | grep -q .; then
    ok "Role '${role}' already assigned"
  else
    az role assignment create --assignee "$principal" --role "$role" --scope "$scope" --output none
    ok "Role '${role}' assigned"
  fi
}

apply_yaml() {
  local user="$1" server="$2" tag="${3:-latest}"
  local app_name="${APP_PREFIX}-${user}"
  local kv_uri="https://${KV}.vault.azure.net"

  local yaml_file
  yaml_file=$(mktemp /tmp/ca-XXXXXX)
  mv "$yaml_file" "${yaml_file}.yaml"
  yaml_file="${yaml_file}.yaml"

  cat > "$yaml_file" <<YAML
properties:
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: false
      targetPort: 3000
      transport: http
      allowInsecure: true
    registries:
      - server: ${server}
        identity: system
    secrets:
      - name: client-id
        keyVaultUrl: ${kv_uri}/secrets/${KV_SECRET_CLIENT_ID}
        identity: system
      - name: tenant-id
        keyVaultUrl: ${kv_uri}/secrets/${KV_SECRET_TENANT_ID}
        identity: system
      - name: allow-domains
        keyVaultUrl: ${kv_uri}/secrets/${KV_SECRET_ALLOW_DOMAINS}
        identity: system
      - name: encryption-key
        keyVaultUrl: ${kv_uri}/secrets/${KV_SECRET_ENCRYPTION_KEY}
        identity: system
      - name: expected-object-id
        keyVaultUrl: ${kv_uri}/secrets/${user}-graph-mcp-object-id
        identity: system
  template:
    containers:
      - name: ${app_name}
        image: ${server}/${IMAGE_NAME}:${tag}
        resources:
          cpu: 0.25
          memory: 0.5Gi
        env:
          - name: GRAPH_MCP_CLIENT_ID
            secretRef: client-id
          - name: GRAPH_MCP_TENANT_ID
            secretRef: tenant-id
          - name: GRAPH_MCP_ALLOW_DOMAINS
            secretRef: allow-domains
          - name: GRAPH_TOKEN_CACHE_ENCRYPTION_KEY
            secretRef: encryption-key
          - name: EXPECTED_AAD_OBJECT_ID
            secretRef: expected-object-id
          - name: HOST
            value: "0.0.0.0"
          - name: NODE_ENV
            value: "production"
          - name: PORT
            value: "3000"
          - name: USER_SLUG
            value: "${user}"
        volumeMounts:
          - volumeName: data
            mountPath: /app/data
        probes:
          - type: Liveness
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
            failureThreshold: 3
          - type: Startup
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 12
          - type: Readiness
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
    volumes:
      - name: data
        storageType: NfsAzureFile
        storageName: ${NFS_STORAGE_NAME}
    scale:
      minReplicas: 1
      maxReplicas: 1
YAML

  az containerapp update \
    --name "$app_name" --resource-group "$RG" \
    --yaml "$yaml_file" --output none
  rm -f "$yaml_file"
  ok "YAML spec applied (KV refs, NFS volume, probes)"
}

print_result() {
  local app_name="$1"
  local fqdn
  fqdn=$(az containerapp show --name "$app_name" --resource-group "$RG" \
    --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null || echo "<pending>")
  echo ""
  ok "${app_name} [${ENV_LABEL}]"
  echo "  FQDN:    ${fqdn}"
  echo "  MCP:     https://${fqdn}/mcp"
  echo "  Health:  https://${fqdn}/health"
}

# ═════════════════════════════════════════════════════════════════════════════
# REMOVE — delete per-user instances
# ═════════════════════════════════════════════════════════════════════════════

cmd_remove() {
  [ $# -eq 0 ] && die "Usage: $0 remove <user> [user...]"
  require_az

  for user in "$@"; do
    validate_user "$user"
    local app_name="${APP_PREFIX}-${user}"
    echo ""
    log "═══ Removing: ${app_name} [${ENV_LABEL}] ═══"

    if resource_exists "az containerapp show --name '$app_name' --resource-group '$RG'"; then
      az containerapp delete --name "$app_name" --resource-group "$RG" --yes --output none
      ok "Container App deleted"
    else
      warn "Container App not found (already removed?)"
    fi
  done
  echo ""
  ok "Remove complete"
  warn "User data remains on the NFS share under graph-mcp-data/<user>/graph-mcp/"
}

# ═════════════════════════════════════════════════════════════════════════════
# LOGIN — device-code MSAL auth for a user
# ═════════════════════════════════════════════════════════════════════════════

cmd_login() {
  [ $# -eq 0 ] && die "Usage: $0 login <user>"
  local user="$1"
  validate_user "$user"
  local app_name="${APP_PREFIX}-${user}"
  require_az

  log "Checking Container App '${app_name}' exists …"
  if ! resource_exists "az containerapp show --name '$app_name' --resource-group '$RG'"; then
    die "Container App '${app_name}' not found. Run: $0 add ${user}"
  fi

  # Wait for a Running replica (up to 120s)
  log "Waiting for a running replica …"
  local waited=0
  while [ $waited -lt 120 ]; do
    local running
    running=$(_timeout 30 az containerapp replica list \
      --name "$app_name" --resource-group "$RG" \
      --query "length([?properties.runningState=='Running'])" -o tsv 2>&1 \
      | tail -1 || echo "0")
    [ "${running:-0}" -gt 0 ] && break
    sleep 5
    waited=$((waited + 5))
    log "Waiting for replica … (${waited}s)"
  done
  [ $waited -ge 120 ] && die "Timed out waiting for replica. Check: $0 logs ${user}"

  log "Connecting to ${app_name} [${ENV_LABEL}] — follow the device-code instructions."
  log "(This may take 30-60 s to establish the exec tunnel …)"
  echo ""
  # az containerapp exec requires a real TTY (it calls tty.setcbreak on stdin).
  # Make runs recipe lines via /bin/sh -c, so stdin may not be a terminal.
  # Reattach stdin to the real TTY so the exec tunnel can set cbreak mode.
  # NOTE: no _timeout here — the command is interactive (user completes
  # device-code auth in a browser) so a hard timeout is inappropriate;
  # Ctrl+C is the correct escape hatch.
  if [ -e /dev/tty ]; then
    exec < /dev/tty
  fi
  az containerapp exec \
    --name "$app_name" --resource-group "$RG" \
    --command "node dist/index.js --login-device"
  local rc=$?
  if [ $rc -ne 0 ]; then
    die "az containerapp exec failed (exit $rc). Run: az containerapp exec --name '$app_name' --resource-group '$RG' --command '/bin/sh' to debug."
  fi

  ok "Login complete for ${user}"
}

# ═════════════════════════════════════════════════════════════════════════════
# SMOKE — remote smoke test against a running user container
# ═════════════════════════════════════════════════════════════════════════════

cmd_smoke() {
  [ $# -eq 0 ] && die "Usage: $0 smoke <user>"
  local user="$1"
  validate_user "$user"
  require_az

  local app_name="${APP_PREFIX}-${user}"
  if ! resource_exists "az containerapp show --name '$app_name' --resource-group '$RG'"; then
    die "Container App '${app_name}' not found. Run: $0 add ${user}"
  fi

  # Wait for a Running replica (up to 120s)
  local waited=0
  while [ $waited -lt 120 ]; do
    local running
    running=$(az containerapp replica list --name "$app_name" --resource-group "$RG" \
      --query "length([?properties.runningState=='Running'])" -o tsv 2>/dev/null || echo "0")
    [ "${running:-0}" -gt 0 ] && break
    sleep 5
    waited=$((waited + 5))
    log "Waiting for replica ... (${waited}s)"
  done
  [ $waited -ge 120 ] && die "Timed out waiting for replica. Check: $0 logs ${user}"

  log "Connecting to ${app_name} [${ENV_LABEL}] for smoke test ..."
  echo ""
  az containerapp exec \
    --name "$app_name" --resource-group "$RG" \
    --command "node dist/index.js --smoke"
}

# ═════════════════════════════════════════════════════════════════════════════
# STATUS — show deployment state
# ═════════════════════════════════════════════════════════════════════════════

cmd_status() {
  require_az
  if [ $# -gt 0 ]; then
    local user="$1"
    validate_user "$user"
    local app_name="${APP_PREFIX}-${user}"
    az containerapp show --name "$app_name" --resource-group "$RG" \
      --query "{Name:name, FQDN:properties.configuration.ingress.fqdn, State:properties.provisioningState, Replicas:properties.runningStatus.replicas}" \
      -o table
  else
    log "Container Apps matching ${APP_PREFIX}-* in ${RG} [${ENV_LABEL}]:"
    az containerapp list --resource-group "$RG" \
      --query "[?starts_with(name, '${APP_PREFIX}-')].{Name:name, FQDN:properties.configuration.ingress.fqdn, State:properties.provisioningState, Replicas:properties.runningStatus.replicas}" \
      -o table
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
# LOGS — tail container logs
# ═════════════════════════════════════════════════════════════════════════════

cmd_logs() {
  [ $# -eq 0 ] && die "Usage: $0 logs <user>"
  local user="$1"
  validate_user "$user"
  require_az
  az containerapp logs show \
    --name "${APP_PREFIX}-${user}" --resource-group "$RG" \
    --follow --tail 100
}

# ═════════════════════════════════════════════════════════════════════════════
# DESTROY — tear down everything or just infra
# ═════════════════════════════════════════════════════════════════════════════

cmd_destroy() {
  require_az
  echo ""
  warn "This will DELETE the entire resource group '${RG}' and ALL resources in it. [${ENV_LABEL}]"
  warn "This includes all Container Apps, secrets, storage, and images."
  echo ""
  read -rp "Type the resource group name to confirm: " confirm
  if [ "$confirm" != "$RG" ]; then
    die "Aborted. You typed '${confirm}', expected '${RG}'."
  fi

  log "Deleting resource group '${RG}' ..."
  az group delete --name "$RG" --yes --no-wait
  ok "Resource group deletion initiated (async). It may take a few minutes."
}

cmd_destroy_infra() {
  require_az
  echo ""
  warn "This will delete shared infrastructure but preserve user Container Apps. [${ENV_LABEL}]"
  warn "Resources to delete: ${LAW}, ${CAE}"
  echo ""

  # Only delete CAE and LAW — preserve ACR/KV/Storage since they hold state
  if resource_exists "az containerapp env show --name '$CAE' --resource-group '$RG'"; then
    log "Deleting Container Apps Environment '${CAE}' ..."
    az containerapp env delete --name "$CAE" --resource-group "$RG" --yes --output none
    ok "Container Apps Environment deleted"
  fi

  if resource_exists "az monitor log-analytics workspace show --workspace-name '$LAW' --resource-group '$RG'"; then
    log "Deleting Log Analytics Workspace '${LAW}' ..."
    az monitor log-analytics workspace delete --workspace-name "$LAW" --resource-group "$RG" --yes --force --output none
    ok "Log Analytics Workspace deleted"
  fi

  echo ""
  ok "Infrastructure teardown complete. ACR, Key Vault, and Storage preserved."
  warn "To delete everything: $0 destroy"
}

# ═════════════════════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════════════════════

ACTION="${1:-help}"
shift || true

case "$ACTION" in
  init)          cmd_init ;;
  plan)          cmd_plan ;;
  build)         cmd_build "$@" ;;
  secrets)       cmd_secrets ;;
  add)           cmd_add "$@" ;;
  remove)        cmd_remove "$@" ;;
  login)         cmd_login "$@" ;;
  smoke)         cmd_smoke "$@" ;;
  status)        cmd_status "$@" ;;
  logs)          cmd_logs "$@" ;;
  destroy)       cmd_destroy ;;
  destroy-infra) cmd_destroy_infra ;;
  help|--help|-h)
    cat <<EOF
Usage: $0 <command> [args]

Infrastructure:
  init                     Create shared infra (RG, ACR, KV, Storage, CAE)
  plan                     Show what exists / what's missing
  destroy                  Delete entire resource group (everything)
  destroy-infra            Delete CAE + Log Analytics only

Image:
  build [tag]              Build & push image to ACR (default: latest)
  secrets                  Seed Key Vault from local .env

Users:
  add <user> [user...]     Deploy per-user Container Apps
  remove <user> [user...]  Delete per-user Container Apps (data preserved on NFS)
  login <user>             Device-code MSAL auth (one-time per user)
  smoke <user>             Remote smoke test (health, tools, find)
  status [user]            Show Container App status
  logs <user>              Tail container logs

Examples:
  $0 init                              # Create shared infra
  $0 build                             # Build image
  $0 add jdoe                          # Deploy for jdoe
  $0 login jdoe                        # One-time auth
  $0 smoke jdoe                        # Run remote smoke tests
  $0 add alice bob                     # Add more users
  $0 status                            # Show all users
  $0 remove alice                      # Remove a user
  $0 destroy                           # Nuke everything

Environment overrides:
  AZURE_ENV_LABEL                (${ENV_LABEL})  — drives default naming
  AZURE_RESOURCE_GROUP         (${RG})
  AZURE_CONTAINERAPPS_ENV      (${CAE})
  AZURE_ACR_NAME               (${ACR})
  AZURE_KEY_VAULT_NAME         (${KV})
  AZURE_LOCATION               (${LOCATION})
  AZURE_LAW_NAME               (${LAW})
  AZURE_STORAGE_ACCOUNT        (${STORAGE_ACCOUNT})
  AZURE_NFS_STORAGE_NAME       (${NFS_STORAGE_NAME})
  AZURE_VNET_NAME              (${VNET_NAME})
  AZURE_SUBNET_NAME            (${SUBNET_NAME})
  AZURE_IMAGE_NAME             (${IMAGE_NAME})
  AZURE_APP_PREFIX             (${APP_PREFIX})

Derived (from ENV_LABEL):
  APP_PREFIX                   (${APP_PREFIX})
  NFS_STORAGE_NAME             (${NFS_STORAGE_NAME})
EOF
    ;;
  *)
    die "Unknown command: ${ACTION}. Run: $0 help"
    ;;
esac
