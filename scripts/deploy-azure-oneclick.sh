#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

ENV_NAME="${AZURE_ENVIRONMENT:-dev}"
LOCATION="${AZURE_LOCATION:-uaenorth}"
REGION_CODE="${AZURE_REGION_CODE:-uaen}"
OWNER_SLUG_RAW="${AZURE_OWNER_SLUG:-mlucian}"

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

OWNER_SLUG="$(slugify "${OWNER_SLUG_RAW}")"
if [[ -z "${OWNER_SLUG}" ]]; then
  OWNER_SLUG="mlucian"
fi

RG_NAME="${AZURE_RESOURCE_GROUP:-rg-openclaw-${ENV_NAME}-${OWNER_SLUG}-${REGION_CODE}}"
VM_NAME="${AZURE_VM_NAME:-vm-openclaw-${ENV_NAME}-${OWNER_SLUG}-${REGION_CODE}-01}"
VM_SIZE="${AZURE_VM_SIZE:-Standard_D2s_v3}"
VM_IMAGE="${AZURE_VM_IMAGE:-Ubuntu2204}"
ADMIN_USER="${AZURE_ADMIN_USER:-azureuser}"
SSH_PUBKEY="${AZURE_SSH_PUBKEY:-$HOME/.ssh/id_rsa.pub}"
ENV_FILE="${ENV_FILE:-.env}"
RUN_COMMAND_WAIT_SECONDS="${AZURE_RUN_COMMAND_WAIT_SECONDS:-900}"
RUN_COMMAND_WAIT_INTERVAL=10

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Missing command '$1'."
    exit 1
  fi
}

normalize_repo_url() {
  local raw_url="$1"
  if [[ "$raw_url" =~ ^git@github\.com:(.+)\.git$ ]]; then
    echo "https://github.com/${BASH_REMATCH[1]}.git"
    return 0
  fi
  if [[ "$raw_url" =~ ^https://github\.com/.+\.git$ ]]; then
    echo "$raw_url"
    return 0
  fi
  return 1
}

need_cmd az
need_cmd git
need_cmd sed
need_cmd base64

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found. Create it first (for example: cp .env_example .env)."
  exit 1
fi

if [[ ! -f "${SSH_PUBKEY}" ]]; then
  echo "ERROR: SSH public key not found at ${SSH_PUBKEY}"
  echo "Run: ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N \"\""
  exit 1
fi

if ! az account show >/dev/null 2>&1; then
  echo "ERROR: Azure CLI is not authenticated. Run: az login"
  exit 1
fi

REMOTE_URL="${AZURE_REPO_URL:-}"
if [[ -z "${REMOTE_URL}" ]]; then
  REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
fi
if [[ -z "${REMOTE_URL}" ]]; then
  echo "ERROR: Could not determine repository URL. Set AZURE_REPO_URL."
  exit 1
fi

if ! NORMALIZED_REPO_URL="$(normalize_repo_url "${REMOTE_URL}")"; then
  echo "ERROR: Unsupported remote URL '${REMOTE_URL}'. Set AZURE_REPO_URL to an https://github.com/...git URL."
  exit 1
fi

TMP_CLOUD_INIT="$(mktemp)"
TMP_RUN_SCRIPT="$(mktemp)"
trap 'rm -f "${TMP_CLOUD_INIT}" "${TMP_RUN_SCRIPT}"' EXIT
sed "s|https://github.com/REPLACE_ME/openclaw-docker.git|${NORMALIZED_REPO_URL}|g" cloud-init.yaml > "${TMP_CLOUD_INIT}"

echo "=== Azure 1-Click Deploy ==="
echo "Resource group: ${RG_NAME}"
echo "Location: ${LOCATION}"
echo "VM: ${VM_NAME} (${VM_SIZE})"
echo "Owner slug: ${OWNER_SLUG}"
echo "Repository: ${NORMALIZED_REPO_URL}"

echo ""
echo "Creating/updating resource group..."
az group create --name "${RG_NAME}" --location "${LOCATION}" --output none

if az vm show --resource-group "${RG_NAME}" --name "${VM_NAME}" >/dev/null 2>&1; then
  echo "VM '${VM_NAME}' already exists. Reusing it."
else
  echo "Creating VM '${VM_NAME}'..."
  az vm create \
    --resource-group "${RG_NAME}" \
    --name "${VM_NAME}" \
    --image "${VM_IMAGE}" \
    --size "${VM_SIZE}" \
    --admin-user "${ADMIN_USER}" \
    --ssh-key-values "${SSH_PUBKEY}" \
    --custom-data "${TMP_CLOUD_INIT}" \
    --public-ip-address "" \
    --output none
fi

PRIVATE_IP="$(az vm show -d --resource-group "${RG_NAME}" --name "${VM_NAME}" --query privateIps -o tsv)"
echo "VM private IP: ${PRIVATE_IP:-unknown}"

echo "Waiting for Azure Run Command agent to become ready..."
ATTEMPTS=$((RUN_COMMAND_WAIT_SECONDS / RUN_COMMAND_WAIT_INTERVAL))
RUN_READY=0
for ((i=1; i<=ATTEMPTS; i++)); do
  if az vm run-command invoke \
    --resource-group "${RG_NAME}" \
    --name "${VM_NAME}" \
    --command-id RunShellScript \
    --scripts "echo ready" \
    --query "value[0].message" \
    -o tsv >/dev/null 2>&1; then
    RUN_READY=1
    break
  fi
  sleep "${RUN_COMMAND_WAIT_INTERVAL}"
done

if [[ "${RUN_READY}" -ne 1 ]]; then
  echo "ERROR: Azure Run Command was not ready in ${RUN_COMMAND_WAIT_SECONDS}s."
  exit 1
fi

ENV_B64="$(base64 < "${ENV_FILE}" | tr -d '\n')"
cat > "${TMP_RUN_SCRIPT}" <<EOF
set -eu
if [ -x /usr/local/bin/bootstrap-openclaw.sh ]; then
  sudo /usr/local/bin/bootstrap-openclaw.sh
fi
sudo mkdir -p /opt/openclaw-docker
printf '%s' '${ENV_B64}' | base64 -d | sudo tee /opt/openclaw-docker/.env >/dev/null
sudo chown ${ADMIN_USER}:${ADMIN_USER} /opt/openclaw-docker/.env
sudo chmod 600 /opt/openclaw-docker/.env
bash -lc 'cd /opt/openclaw-docker && make build && make up && make provision'
EOF

echo "Running build/up/provision on VM via Azure Run Command..."
az vm run-command invoke \
  --resource-group "${RG_NAME}" \
  --name "${VM_NAME}" \
  --command-id RunShellScript \
  --scripts @"${TMP_RUN_SCRIPT}" \
  --query "value[0].message" \
  -o tsv >/dev/null

echo ""
echo "========================================"
echo "Deployment complete."
echo "========================================"
echo "Resource Group: ${RG_NAME}"
echo "VM: ${VM_NAME}"
echo "Private IP: ${PRIVATE_IP:-unknown}"
echo "Use Azure Bastion or private network access to connect interactively."
echo "To inspect logs via control plane:"
echo "az vm run-command invoke -g ${RG_NAME} -n ${VM_NAME} --command-id RunShellScript --scripts 'docker logs --tail 200 openclaw'"
