#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

AZURE_ENV_FILE="${AZURE_ENV_FILE:-.env.azure}"
if [[ -f "$AZURE_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$AZURE_ENV_FILE"
  set +a
fi

usage() {
  cat <<'EOF'
One-click-ish Azure VM deployment for OpenClaw.

Usage:
  infra/azure/deploy-azure.sh \
    --resource-group <name> \
    --vm-name <name> \
    [--location <azure-location>] \
    [--admin-user <username>] \
    [--vm-size <size>] \
    [--repo-url <git-url>] \
    [--private] \
    [--vnet-name <name>] \
    [--subnet-name <name>] \
    [--copy-env]

Options:
  --resource-group   Azure resource group (required)
  --vm-name          VM name (required)
  --location         Azure location (default: uaenorth)
  --admin-user       Admin username (default: azureuser)
  --vm-size          VM size (default: Standard_D4s_v5)
  --repo-url         Repo URL for cloud-init bootstrap
                     (default: https://github.com/your-org/openclaw-docker.git)
  --private          Deploy VM with no public IP and no inbound NSG rules
  --vnet-name        VNet name for private mode (default: vnet-openclaw)
  --subnet-name      Subnet name for private mode (default: snet-openclaw)
  --copy-env         Copy local .env to VM and run build+provision automatically
  -h, --help         Show this help
EOF
}

SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-}"
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-}"
VM_NAME="${AZURE_VM_NAME:-}"
LOCATION="${AZURE_LOCATION:-uaenorth}"
ADMIN_USER="${AZURE_ADMIN_USER:-azureuser}"
VM_SIZE="${AZURE_VM_SIZE:-Standard_D4s_v5}"
REPO_URL="${AZURE_REPO_URL:-https://github.com/your-org/openclaw-docker.git}"
COPY_ENV="${AZURE_COPY_ENV:-0}"
PRIVATE_MODE="${AZURE_PRIVATE_MODE:-0}"
VNET_NAME="${AZURE_VNET_NAME:-vnet-openclaw}"
SUBNET_NAME="${AZURE_SUBNET_NAME:-snet-openclaw}"
VNET_CIDR="${AZURE_VNET_CIDR:-10.40.0.0/16}"
SUBNET_CIDR="${AZURE_SUBNET_CIDR:-10.40.1.0/24}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group) RESOURCE_GROUP="${2:-}"; shift 2 ;;
    --vm-name) VM_NAME="${2:-}"; shift 2 ;;
    --location) LOCATION="${2:-}"; shift 2 ;;
    --admin-user) ADMIN_USER="${2:-}"; shift 2 ;;
    --vm-size) VM_SIZE="${2:-}"; shift 2 ;;
    --repo-url) REPO_URL="${2:-}"; shift 2 ;;
    --private) PRIVATE_MODE="1"; shift ;;
    --vnet-name) VNET_NAME="${2:-}"; shift 2 ;;
    --subnet-name) SUBNET_NAME="${2:-}"; shift 2 ;;
    --copy-env) COPY_ENV="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$RESOURCE_GROUP" || -z "$VM_NAME" ]]; then
  echo "Error: --resource-group and --vm-name are required." >&2
  usage >&2
  exit 1
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Error: az CLI is required." >&2
  exit 1
fi

if ! az account show >/dev/null 2>&1; then
  echo "Error: Azure CLI is not logged in. Run: az login" >&2
  exit 1
fi

if [[ -n "$SUBSCRIPTION_ID" ]]; then
  az account set --subscription "$SUBSCRIPTION_ID"
fi

if [[ "$PRIVATE_MODE" == "1" && "$COPY_ENV" == "1" ]]; then
  echo "Error: --copy-env is not supported with --private (no public SSH path)." >&2
  exit 1
fi

run_bootstrap_check() {
  local cmd_output
  cmd_output="$(az vm run-command invoke \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --command-id RunShellScript \
    --scripts "
set -euo pipefail
if [[ ! -f /opt/openclaw-docker/README.md ]]; then
  sudo REPO_URL='${REPO_URL}' /usr/local/bin/bootstrap-openclaw.sh
fi
if [[ ! -f /opt/openclaw-docker/README.md ]]; then
  echo 'bootstrap_failed: /opt/openclaw-docker/README.md missing' >&2
  exit 1
fi
echo bootstrap_ok
" \
    --query "value[0].message" -o tsv)"
  echo "$cmd_output" >/dev/null
}

CLOUD_INIT_TEMPLATE="infra/azure/cloud-init.yaml"
if [[ ! -f "$CLOUD_INIT_TEMPLATE" ]]; then
  echo "Error: missing $CLOUD_INIT_TEMPLATE" >&2
  exit 1
fi

TMP_CLOUD_INIT="$(mktemp)"
cleanup() {
  rm -f "$TMP_CLOUD_INIT"
}
trap cleanup EXIT

python3 - "$CLOUD_INIT_TEMPLATE" "$TMP_CLOUD_INIT" "$REPO_URL" <<'PY'
from pathlib import Path
import sys

src = Path(sys.argv[1]).read_text(encoding="utf-8")
dst = Path(sys.argv[2])
repo = sys.argv[3]
dst.write_text(src.replace("https://github.com/REPLACE_ME/openclaw-docker.git", repo), encoding="utf-8")
PY

echo "Creating resource group: $RESOURCE_GROUP ($LOCATION)"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" >/dev/null

if [[ "$PRIVATE_MODE" == "1" ]]; then
  echo "Private mode enabled: creating VNet/Subnet and VM without public IP."
  az network vnet create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VNET_NAME" \
    --address-prefixes "$VNET_CIDR" \
    --subnet-name "$SUBNET_NAME" \
    --subnet-prefixes "$SUBNET_CIDR" \
    --output none

  az vm create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --image Ubuntu2204 \
    --size "$VM_SIZE" \
    --admin-username "$ADMIN_USER" \
    --generate-ssh-keys \
    --custom-data "$TMP_CLOUD_INIT" \
    --vnet-name "$VNET_NAME" \
    --subnet "$SUBNET_NAME" \
    --public-ip-address "" \
    --nsg-rule NONE \
    --output none

  PRIVATE_IP="$(az vm list-ip-addresses -g "$RESOURCE_GROUP" -n "$VM_NAME" --query "[0].virtualMachine.network.privateIpAddresses[0]" -o tsv)"
  echo "VM private IP: ${PRIVATE_IP}"
  echo "No public IP and no inbound NSG rules were created."
else
  echo "Creating VM: $VM_NAME"
  az vm create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --image Ubuntu2204 \
    --size "$VM_SIZE" \
    --admin-username "$ADMIN_USER" \
    --generate-ssh-keys \
    --custom-data "$TMP_CLOUD_INIT" \
    --public-ip-sku Standard \
    --output none

  echo "Restricting inbound NSG to SSH only"
  az vm open-port \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --port 22 \
    --priority 1001 \
    --output none || true

  PUBLIC_IP="$(az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query publicIps -o tsv)"
  echo "VM public IP: $PUBLIC_IP"
fi

echo "Verifying bootstrap on VM..."
run_bootstrap_check
echo "Bootstrap verified: /opt/openclaw-docker populated."

if [[ "$COPY_ENV" == "1" ]]; then
  if [[ ! -f ".env" ]]; then
    echo "Error: --copy-env requested but local .env not found." >&2
    exit 1
  fi

  echo "Waiting for SSH..."
  for _ in $(seq 1 40); do
    if ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no "${ADMIN_USER}@${PUBLIC_IP}" "echo ok" >/dev/null 2>&1; then
      break
    fi
    sleep 5
  done

  echo "Copying .env and running remote build+provision..."
  scp -o StrictHostKeyChecking=no .env "${ADMIN_USER}@${PUBLIC_IP}:/tmp/openclaw.env"
  ssh -o StrictHostKeyChecking=no "${ADMIN_USER}@${PUBLIC_IP}" bash -lc "'
    set -euo pipefail
    sudo mv /tmp/openclaw.env /opt/openclaw-docker/.env
    sudo chown ${ADMIN_USER}:${ADMIN_USER} /opt/openclaw-docker/.env
    chmod 600 /opt/openclaw-docker/.env
    cd /opt/openclaw-docker
    docker compose build
    OPENCLAW_ALLOW_INSECURE_BYPASS=1 OPENCLAW_SKIP_AUTH_CHECKS=clippy,whoop bin/openclawctl provision
  '"
fi

cat <<EOF
Deployment complete.

Next steps:
EOF

if [[ "$PRIVATE_MODE" == "1" ]]; then
  cat <<EOF
1) Access via Azure Bastion / VPN / jumpbox into VNet ${VNET_NAME}.
2) On VM, run:
   cd /opt/openclaw-docker
   cp .env.example .env
   # edit .env
   docker compose build
   bin/openclawctl provision
EOF
else
  cat <<EOF
1) SSH into VM:
   ssh ${ADMIN_USER}@${PUBLIC_IP}
2) If you did not pass --copy-env:
   cd /opt/openclaw-docker
   cp .env.example .env
   # edit .env
   docker compose build
   bin/openclawctl provision
EOF
fi
