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
    [--mode auto|create|update|redeploy] \
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
  --mode             Deployment mode:
                     - auto (default): create if missing, update if exists
                     - create: fail if VM already exists
                     - update: fail if VM does not exist
                     - redeploy: delete existing VM then create it again
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
DEPLOY_MODE="${AZURE_DEPLOY_MODE:-auto}"

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
    --mode) DEPLOY_MODE="${2:-}"; shift 2 ;;
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

case "$DEPLOY_MODE" in
  auto|create|update|redeploy) ;;
  *)
    echo "Error: invalid --mode '$DEPLOY_MODE' (expected auto|create|update|redeploy)." >&2
    exit 1
    ;;
esac

run_bootstrap_check() {
  local cmd_output
  cmd_output="$(az vm run-command invoke \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --command-id RunShellScript \
    --scripts "bash -lc '
set -euo pipefail
if [[ ! -f /opt/openclaw-docker/README.md ]]; then
  sudo REPO_URL=\"${REPO_URL}\" /usr/local/bin/bootstrap-openclaw.sh
fi
if [[ ! -f /opt/openclaw-docker/README.md ]]; then
  echo \"bootstrap_failed: /opt/openclaw-docker/README.md missing\" >&2
  exit 1
fi
echo bootstrap_ok
'" \
    --query "value[0].message" -o tsv)"
  echo "$cmd_output" >/dev/null
}

run_update_only() {
  echo "Updating existing VM bootstrap/repo..."
  az vm run-command invoke \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --command-id RunShellScript \
    --scripts "bash -lc '
set -euo pipefail
sudo REPO_URL=\"${REPO_URL}\" /usr/local/bin/bootstrap-openclaw.sh
sudo chown -R ${ADMIN_USER}:${ADMIN_USER} /opt/openclaw-docker
cd /opt/openclaw-docker
git rev-parse --short HEAD
'" \
    --output none

  echo "Update complete."
}

ensure_ssh_inbound_rules() {
  local nic_name nic_nsg_id subnet_id subnet_nsg_id

  nic_name="$(az vm show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --query "networkProfile.networkInterfaces[0].id" -o tsv | awk -F/ '{print $NF}')"

  if [[ -z "$nic_name" ]]; then
    echo "Warning: unable to resolve NIC name for VM '$VM_NAME'; skipping SSH NSG ensure." >&2
    return 0
  fi

  nic_nsg_id="$(az network nic show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$nic_name" \
    --query "networkSecurityGroup.id" -o tsv || true)"

  subnet_id="$(az network nic show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$nic_name" \
    --query "ipConfigurations[0].subnet.id" -o tsv || true)"

  subnet_nsg_id=""
  if [[ -n "$subnet_id" ]]; then
    subnet_nsg_id="$(az resource show --ids "$subnet_id" --query "properties.networkSecurityGroup.id" -o tsv || true)"
  fi

  ensure_ssh_rule_for_nsg() {
    local nsg_id="$1"
    local rule_name="$2"
    local nsg_name
    local has_ssh_allow

    [[ -n "$nsg_id" ]] || return 0
    nsg_name="$(awk -F/ '{print $NF}' <<<"$nsg_id")"

    has_ssh_allow="$(az network nsg rule list \
      --resource-group "$RESOURCE_GROUP" \
      --nsg-name "$nsg_name" \
      --query "[?direction=='Inbound' && access=='Allow' && (protocol=='Tcp' || protocol=='*' || protocol=='All') && (destinationPortRange=='22' || destinationPortRange=='22-22' || contains(destinationPortRanges, '22') || contains(destinationPortRanges, '22-22'))] | length(@)" -o tsv || echo "0")"

    if [[ "$has_ssh_allow" != "0" ]]; then
      echo "SSH allow rule already present on NSG: ${nsg_name}"
      return 0
    fi

    echo "Adding SSH allow rule on NSG: ${nsg_name}"
    az network nsg rule create \
      --resource-group "$RESOURCE_GROUP" \
      --nsg-name "$nsg_name" \
      --name "$rule_name" \
      --priority 3001 \
      --access Allow \
      --direction Inbound \
      --protocol Tcp \
      --source-address-prefixes Internet \
      --source-port-ranges "*" \
      --destination-address-prefixes "*" \
      --destination-port-ranges 22 \
      --output none
  }

  ensure_ssh_rule_for_nsg "$nic_nsg_id" "openclaw-allow-ssh-nic"
  ensure_ssh_rule_for_nsg "$subnet_nsg_id" "openclaw-allow-ssh-subnet"
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

if az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" >/dev/null 2>&1; then
  VM_EXISTS="1"
else
  VM_EXISTS="0"
fi

if [[ "$DEPLOY_MODE" == "create" && "$VM_EXISTS" == "1" ]]; then
  echo "Error: VM '$VM_NAME' already exists and --mode=create was requested." >&2
  exit 1
fi

if [[ "$DEPLOY_MODE" == "update" && "$VM_EXISTS" == "0" ]]; then
  echo "Error: VM '$VM_NAME' does not exist and --mode=update was requested." >&2
  exit 1
fi

if [[ "$DEPLOY_MODE" == "redeploy" && "$VM_EXISTS" == "1" ]]; then
  echo "Redeploy mode: deleting existing VM '$VM_NAME'..."
  az vm delete --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --yes --no-wait false
  VM_EXISTS="0"
fi

if [[ "$DEPLOY_MODE" == "auto" && "$VM_EXISTS" == "1" ]]; then
  echo "VM '$VM_NAME' already exists; switching to update flow (mode=auto)."
  DEPLOY_MODE="update"
fi

if [[ "$DEPLOY_MODE" == "update" ]]; then
  run_update_only
  echo "Verifying bootstrap on VM..."
  run_bootstrap_check
  echo "Bootstrap verified: /opt/openclaw-docker populated."

  if [[ "$PRIVATE_MODE" == "0" ]]; then
    echo "Ensuring inbound NSG allows SSH (port 22)..."
    ensure_ssh_inbound_rules
    PUBLIC_IP="$(az vm show -d -g "$RESOURCE_GROUP" -n "$VM_NAME" --query publicIps -o tsv)"
  fi

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
Update complete.

Next steps:
EOF

  if [[ "$PRIVATE_MODE" == "1" ]]; then
    cat <<EOF
1) Access via Azure Bastion / VPN / jumpbox into VNet ${VNET_NAME}.
2) On VM, run as needed:
   cd /opt/openclaw-docker
   git pull --ff-only
   docker compose build
   bin/openclawctl provision
EOF
  else
    cat <<EOF
1) SSH into VM:
   ssh ${ADMIN_USER}@${PUBLIC_IP}
2) On VM, run as needed:
   cd /opt/openclaw-docker
   git pull --ff-only
   docker compose build
   bin/openclawctl provision
EOF
  fi
  exit 0
fi

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
    --authentication-type ssh \
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
    --authentication-type ssh \
    --generate-ssh-keys \
    --custom-data "$TMP_CLOUD_INIT" \
    --public-ip-sku Standard \
    --output none

  echo "Restricting inbound NSG to SSH only"
  ensure_ssh_inbound_rules

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
