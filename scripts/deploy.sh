#!/usr/bin/env bash
set -euo pipefail

# Deploy graph-mcp-gateway to Azure Container Apps via Terraform.
# All resources deploy in UAE North with private endpoints (ACR, Storage).
# Container Apps are internal-only (VNet).
#
# Usage:
#   ./scripts/deploy.sh                # Apply (deploy all users)
#   ./scripts/deploy.sh plan           # Plan only
#   ./scripts/deploy.sh destroy        # Tear down everything
#   ./scripts/deploy.sh add alice      # Add a single user
#   ./scripts/deploy.sh remove alice   # Remove a single user
#   ./scripts/deploy.sh push           # Build & push image to ACR

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INFRA_DIR="$PROJECT_DIR/infra"

ACTION="${1:-apply}"
USER_ARG="${2:-}"

# Require jq for JSON parsing
command -v jq >/dev/null 2>&1 || { echo "Error: jq is required but not installed. Install with: brew install jq (macOS) or apt-get install jq (Ubuntu)"; exit 1; }

# Validate required env vars
: "${GRAPH_MCP_CLIENT_ID:?Set GRAPH_MCP_CLIENT_ID}"
: "${GRAPH_MCP_TENANT_ID:?Set GRAPH_MCP_TENANT_ID}"
: "${CONTAINER_IMAGE:?Set CONTAINER_IMAGE (e.g., myregistry.azurecr.io/graph-mcp-gateway:latest)}"

cd "$INFRA_DIR"

TF_VARS=(
  -var "graph_mcp_client_id=$GRAPH_MCP_CLIENT_ID"
  -var "graph_mcp_tenant_id=$GRAPH_MCP_TENANT_ID"
  -var "container_image=$CONTAINER_IMAGE"
)

# Initialize Terraform
terraform init -upgrade

case "$ACTION" in
  plan)
    terraform plan "${TF_VARS[@]}"
    ;;
  apply)
    terraform apply -auto-approve "${TF_VARS[@]}"
    echo ""
    echo "Deployed! Gateway URLs:"
    terraform output -json gateway_urls
    ;;
  destroy)
    terraform destroy -auto-approve "${TF_VARS[@]}"
    ;;
  add)
    [ -z "$USER_ARG" ] && { echo "Usage: $0 add <username>"; exit 1; }
    # Read current users from state, append new one
    CURRENT=$(terraform output -json gateway_urls 2>/dev/null | jq -r 'keys | join(",")' 2>/dev/null || echo "")
    if echo "$CURRENT" | grep -qw "$USER_ARG"; then
      echo "User '$USER_ARG' already deployed."
      terraform output -json gateway_urls | jq -r --arg u "$USER_ARG" '.[$u]'
      exit 0
    fi
    NEW_USERS="$CURRENT,$USER_ARG"
    # Convert comma-separated to Terraform list
    TF_LIST=$(echo "$NEW_USERS" | tr ',' '\n' | sed '/^$/d' | sort -u | awk '{printf "\"%s\",", $0}' | sed 's/,$//')
    terraform apply -auto-approve "${TF_VARS[@]}" -var "users=[$TF_LIST]"
    echo ""
    echo "User '$USER_ARG' deployed:"
    terraform output -json gateway_urls | jq -r --arg u "$USER_ARG" '.[$u] // "unknown"'
    ;;
  remove)
    [ -z "$USER_ARG" ] && { echo "Usage: $0 remove <username>"; exit 1; }
    CURRENT=$(terraform output -json gateway_urls 2>/dev/null | jq -r --arg u "$USER_ARG" '[keys[] | select(. != $u)] | join(",")' 2>/dev/null || echo "")
    TF_LIST=$(echo "$CURRENT" | tr ',' '\n' | sed '/^$/d' | awk '{printf "\"%s\",", $0}' | sed 's/,$//')
    terraform apply -auto-approve "${TF_VARS[@]}" -var "users=[$TF_LIST]"
    echo "User '$USER_ARG' removed."
    ;;
  push)
    # Build and push image to ACR (requires `az login` and ACR already deployed)
    ACR_SERVER=$(terraform output -raw acr_login_server 2>/dev/null || echo "")
    [ -z "$ACR_SERVER" ] && { echo "ACR not deployed yet. Run '$0 apply' first."; exit 1; }
    TAG="${USER_ARG:-latest}"
    IMAGE="$ACR_SERVER/graph-mcp-gateway:$TAG"
    echo "Building and pushing $IMAGE ..."
    az acr login --name "${ACR_SERVER%%.*}"
    docker build -t "$IMAGE" "$PROJECT_DIR"
    docker push "$IMAGE"
    echo "Pushed: $IMAGE"
    echo "Set CONTAINER_IMAGE=$IMAGE and run '$0 apply' to deploy."
    ;;
  *)
    echo "Usage: $0 [plan|apply|destroy|add <user>|remove <user>|push [tag]]"
    exit 1
    ;;
esac
