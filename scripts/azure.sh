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
#   ./scripts/azure.sh status [user]            Show deployment status
#   ./scripts/azure.sh logs <user>              Tail container logs
#   ./scripts/azure.sh destroy                  Tear down EVERYTHING (shared + users)
#   ./scripts/azure.sh destroy-infra            Tear down shared infra only
#
# Environment overrides (all have defaults):
#   AZURE_RESOURCE_GROUP         AZURE_CONTAINERAPPS_ENV
#   AZURE_ACR_NAME               AZURE_KEY_VAULT_NAME
#   AZURE_STORAGE_ACCOUNT_NAME   AZURE_LOCATION
# ──────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Shared resource names (override via env vars) ────────────────────────────
RG="${AZURE_RESOURCE_GROUP:-rg-openclaw-shared-dev}"
CAE="${AZURE_CONTAINERAPPS_ENV:-cae-openclaw-shared-dev}"
ACR="${AZURE_ACR_NAME:-openclawshareddevacr}"
KV="${AZURE_KEY_VAULT_NAME:-kvopenclawshareddev}"
STORAGE="${AZURE_STORAGE_ACCOUNT_NAME:-stopenclawshareddev}"
LOCATION="${AZURE_LOCATION:-uaenorth}"
LAW="law-openclaw-shared-dev"

# ── Naming conventions ───────────────────────────────────────────────────────
IMAGE_NAME="graph-mcp-gateway"
APP_PREFIX="ca-graph-mcp-gw"          # → ca-graph-mcp-gw-mlucian
SHARE_PREFIX="graph-mcp-gw"           # → graph-mcp-gw-mlucian
STORAGE_MOUNT_NAME="gw-data"          # internal volume name in Container App

# ── Key Vault secret names ───────────────────────────────────────────────────
KV_SECRET_CLIENT_ID="graph-mcp-client-id"
KV_SECRET_TENANT_ID="graph-mcp-tenant-id"

# ── Helpers ──────────────────────────────────────────────────────────────────

log()    { printf '\033[0;36m▸ %s\033[0m\n' "$*"; }
ok()     { printf '\033[0;32m✓ %s\033[0m\n' "$*"; }
warn()   { printf '\033[0;33m⚠ %s\033[0m\n' "$*"; }
err()    { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; }
die()    { err "$@"; exit 1; }
exists() { printf '\033[0;32m  ✓ exists\033[0m  %s\n' "$*"; }
missing(){ printf '\033[0;33m  ✗ missing\033[0m %s\n' "$*"; }

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
  az account show >/dev/null 2>&1 || die "Not logged in. Run: az login"
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

_storage_key=""
storage_key() {
  if [ -z "$_storage_key" ]; then
    _storage_key=$(az storage account keys list \
      --account-name "$STORAGE" --resource-group "$RG" \
      --query '[0].value' -o tsv 2>/dev/null || echo "")
  fi
  echo "$_storage_key"
}

# ═════════════════════════════════════════════════════════════════════════════
# PLAN — dry-run showing what exists and what's missing
# ═════════════════════════════════════════════════════════════════════════════

cmd_plan() {
  require_az
  echo ""
  log "Azure deployment plan for graph-mcp-gateway"
  log "Location: ${LOCATION}"
  echo ""

  echo "── Shared Infrastructure ──────────────────────────────────"
  check_resource "Resource Group:            ${RG}" \
    "az group show --name '$RG'"
  check_resource "Container Registry:        ${ACR}" \
    "az acr show --name '$ACR' --resource-group '$RG'"
  check_resource "Key Vault:                 ${KV}" \
    "az keyvault show --name '$KV' --resource-group '$RG'"
  check_resource "Storage Account:           ${STORAGE}" \
    "az storage account show --name '$STORAGE' --resource-group '$RG'"
  check_resource "Log Analytics:             ${LAW}" \
    "az monitor log-analytics workspace show --workspace-name '$LAW' --resource-group '$RG'"
  check_resource "Container Apps Env:        ${CAE}" \
    "az containerapp env show --name '$CAE' --resource-group '$RG'"
  echo ""

  echo "── Key Vault Secrets ──────────────────────────────────────"
  check_resource "Secret: ${KV_SECRET_CLIENT_ID}" \
    "az keyvault secret show --vault-name '$KV' --name '$KV_SECRET_CLIENT_ID'"
  check_resource "Secret: ${KV_SECRET_TENANT_ID}" \
    "az keyvault secret show --vault-name '$KV' --name '$KV_SECRET_TENANT_ID'"
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
  log "═══ Initializing shared infrastructure ═══"
  log "Location: ${LOCATION}   Resource Group: ${RG}"
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

  # 4. Storage Account
  if resource_exists "az storage account show --name '$STORAGE' --resource-group '$RG'"; then
    ok "Storage Account '${STORAGE}' exists"
  else
    log "Creating Storage Account '${STORAGE}' ..."
    az storage account create \
      --name "$STORAGE" \
      --resource-group "$RG" \
      --location "$LOCATION" \
      --sku Standard_LRS \
      --kind StorageV2 \
      --output none
    ok "Storage Account '${STORAGE}' created"
  fi

  # 5. Log Analytics Workspace
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

  # 6. Container Apps Environment
  if resource_exists "az containerapp env show --name '$CAE' --resource-group '$RG'"; then
    ok "Container Apps Environment '${CAE}' exists"
  else
    log "Creating Container Apps Environment '${CAE}' ..."
    local law_id law_key
    law_id=$(az monitor log-analytics workspace show \
      --workspace-name "$LAW" --resource-group "$RG" \
      --query customerId -o tsv)
    law_key=$(az monitor log-analytics workspace get-shared-keys \
      --workspace-name "$LAW" --resource-group "$RG" \
      --query primarySharedKey -o tsv)

    az containerapp env create \
      --name "$CAE" \
      --resource-group "$RG" \
      --location "$LOCATION" \
      --logs-workspace-id "$law_id" \
      --logs-workspace-key "$law_key" \
      --output none
    ok "Container Apps Environment '${CAE}' created"
  fi

  # 7. Seed secrets from .env
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
    "az storage account show --name '$STORAGE' --resource-group '$RG'"; do
    if ! resource_exists "$check"; then
      die "Shared infrastructure incomplete. Run: $0 init"
    fi
  done

  # Verify KV secrets
  for s in "$KV_SECRET_CLIENT_ID" "$KV_SECRET_TENANT_ID"; do
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

  for user in "$@"; do
    validate_user "$user"
    deploy_user "$user" "$server"
  done

  echo ""
  ok "Done. For each new user, run:  $0 login <user>"
}

deploy_user() {
  local user="$1" server="$2"
  local app_name="${APP_PREFIX}-${user}"
  local share_name="${SHARE_PREFIX}-${user}"

  echo ""
  log "═══ ${app_name} ═══"

  # File share
  if resource_exists "az storage share-rm show --storage-account '$STORAGE' --resource-group '$RG' --name '$share_name'"; then
    ok "File share '${share_name}' exists"
  else
    log "Creating file share '${share_name}' ..."
    az storage share-rm create \
      --storage-account "$STORAGE" --resource-group "$RG" \
      --name "$share_name" --quota 1 --output none
    ok "File share '${share_name}' created (1 GiB)"
  fi

  # Container App
  if resource_exists "az containerapp show --name '$app_name' --resource-group '$RG'"; then
    log "Container App exists — updating ..."
    update_user "$user" "$server"
  else
    log "Creating Container App ..."
    create_user "$user" "$server"
  fi
}

create_user() {
  local user="$1" server="$2"
  local app_name="${APP_PREFIX}-${user}"
  local share_name="${SHARE_PREFIX}-${user}"
  local skey
  skey=$(storage_key)

  # Phase 1: create with placeholder env vars (identity doesn't exist yet)
  az containerapp create \
    --name "$app_name" \
    --resource-group "$RG" \
    --environment "$CAE" \
    --image "${server}/${IMAGE_NAME}:latest" \
    --registry-server "$server" \
    --system-assigned \
    --target-port 3000 \
    --ingress internal \
    --transport http \
    --min-replicas 0 --max-replicas 1 \
    --cpu 0.25 --memory 0.5Gi \
    --env-vars \
      "GRAPH_MCP_CLIENT_ID=placeholder" \
      "GRAPH_MCP_TENANT_ID=placeholder" \
      "HOST=0.0.0.0" \
      "NODE_ENV=production" \
      "PORT=3000" \
    --output none
  ok "Container App created (phase 1)"

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

  # Phase 3: register storage mount, then apply full YAML spec
  az containerapp storage set \
    --name "$app_name" --resource-group "$RG" \
    --storage-name "${STORAGE_MOUNT_NAME}-${user}" \
    --azure-file-account-name "$STORAGE" \
    --azure-file-account-key "$skey" \
    --azure-file-share-name "$share_name" \
    --access-mode ReadWrite --output none
  ok "Storage mount registered"

  apply_yaml "$user" "$server" "$skey"

  az containerapp registry set \
    --name "$app_name" --resource-group "$RG" \
    --server "$server" --identity system \
    --output none 2>/dev/null || true

  print_result "$app_name"
}

update_user() {
  local user="$1" server="$2"
  local app_name="${APP_PREFIX}-${user}"
  local share_name="${SHARE_PREFIX}-${user}"
  local skey
  skey=$(storage_key)

  # Ensure storage mount
  az containerapp storage set \
    --name "$app_name" --resource-group "$RG" \
    --storage-name "${STORAGE_MOUNT_NAME}-${user}" \
    --azure-file-account-name "$STORAGE" \
    --azure-file-account-key "$skey" \
    --azure-file-share-name "$share_name" \
    --access-mode ReadWrite --output none 2>/dev/null || true

  apply_yaml "$user" "$server" "$skey"

  az containerapp registry set \
    --name "$app_name" --resource-group "$RG" \
    --server "$server" --identity system \
    --output none 2>/dev/null || true

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
  local user="$1" server="$2" skey="$3"
  local app_name="${APP_PREFIX}-${user}"
  local kv_uri="https://${KV}.vault.azure.net"

  local yaml_file
  yaml_file=$(mktemp /tmp/ca-XXXXXX.yaml)

  cat > "$yaml_file" <<YAML
properties:
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: false
      targetPort: 3000
      transport: http
      allowInsecure: false
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
      - name: storage-key
        value: "${skey}"
  template:
    containers:
      - name: ${app_name}
        image: ${server}/${IMAGE_NAME}:latest
        resources:
          cpu: 0.25
          memory: 0.5Gi
        env:
          - name: GRAPH_MCP_CLIENT_ID
            secretRef: client-id
          - name: GRAPH_MCP_TENANT_ID
            secretRef: tenant-id
          - name: HOST
            value: "0.0.0.0"
          - name: NODE_ENV
            value: "production"
          - name: PORT
            value: "3000"
        volumeMounts:
          - volumeName: ${STORAGE_MOUNT_NAME}
            mountPath: /home/node/m365-graph-mcp-gateway
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
      - name: ${STORAGE_MOUNT_NAME}
        storageType: AzureFile
        storageName: ${STORAGE_MOUNT_NAME}-${user}
    scale:
      minReplicas: 0
      maxReplicas: 1
YAML

  az containerapp update \
    --name "$app_name" --resource-group "$RG" \
    --yaml "$yaml_file" --output none
  rm -f "$yaml_file"
  ok "YAML spec applied (KV refs, volume, probes)"
}

print_result() {
  local app_name="$1"
  local fqdn
  fqdn=$(az containerapp show --name "$app_name" --resource-group "$RG" \
    --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null || echo "<pending>")
  echo ""
  ok "${app_name}"
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
    local share_name="${SHARE_PREFIX}-${user}"
    echo ""
    log "═══ Removing: ${app_name} ═══"

    if resource_exists "az containerapp show --name '$app_name' --resource-group '$RG'"; then
      az containerapp delete --name "$app_name" --resource-group "$RG" --yes --output none
      ok "Container App deleted"
    else
      warn "Container App not found (already removed?)"
    fi

    if resource_exists "az storage share-rm show --storage-account '$STORAGE' --resource-group '$RG' --name '$share_name'"; then
      az storage share-rm delete --storage-account "$STORAGE" --resource-group "$RG" --name "$share_name" --yes --output none
      ok "File share deleted"
    else
      warn "File share not found (already removed?)"
    fi
  done
  echo ""
  ok "Remove complete"
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

  if ! resource_exists "az containerapp show --name '$app_name' --resource-group '$RG'"; then
    die "Container App '${app_name}' not found. Run: $0 add ${user}"
  fi

  # Scale up if at zero
  local replicas
  replicas=$(az containerapp show --name "$app_name" --resource-group "$RG" \
    --query "properties.runningStatus.replicas" -o tsv 2>/dev/null || echo "0")
  local was_zero=false

  if [ "${replicas:-0}" = "0" ]; then
    was_zero=true
    log "Scaling to 1 replica for login ..."
    az containerapp update --name "$app_name" --resource-group "$RG" --min-replicas 1 --output none
    log "Waiting for replica ..."
    sleep 20
  fi

  log "Connecting to ${app_name} — follow the device-code instructions."
  echo ""
  az containerapp exec \
    --name "$app_name" --resource-group "$RG" \
    --command "node dist/index.js --login-device"

  # Restore scale-to-zero
  if [ "$was_zero" = true ]; then
    log "Restoring scale-to-zero ..."
    az containerapp update --name "$app_name" --resource-group "$RG" --min-replicas 0 --output none
  fi
  ok "Login complete for ${user}"
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
    log "Container Apps matching ${APP_PREFIX}-* in ${RG}:"
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
  warn "This will DELETE the entire resource group '${RG}' and ALL resources in it."
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
  warn "This will delete shared infrastructure but preserve user Container Apps."
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
  remove <user> [user...]  Delete per-user Container Apps + file shares
  login <user>             Device-code MSAL auth (one-time per user)
  status [user]            Show Container App status
  logs <user>              Tail container logs

Examples:
  $0 init                              # Create shared infra
  $0 build                             # Build image
  $0 add mlucian                       # Deploy for mlucian
  $0 login mlucian                     # One-time auth
  $0 add alice bob                     # Add more users
  $0 status                            # Show all users
  $0 remove alice                      # Remove a user
  $0 destroy                           # Nuke everything

Environment overrides:
  AZURE_RESOURCE_GROUP         (${RG})
  AZURE_CONTAINERAPPS_ENV      (${CAE})
  AZURE_ACR_NAME               (${ACR})
  AZURE_KEY_VAULT_NAME         (${KV})
  AZURE_STORAGE_ACCOUNT_NAME   (${STORAGE})
  AZURE_LOCATION               (${LOCATION})
EOF
    ;;
  *)
    die "Unknown command: ${ACTION}. Run: $0 help"
    ;;
esac
