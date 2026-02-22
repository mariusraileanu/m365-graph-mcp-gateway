terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  # ── Remote backend (uncomment after bootstrap) ────────────
  # Store state in Azure Blob Storage for team collaboration.
  #
  # Bootstrap steps:
  #   1. Create a resource group:
  #      az group create -n rg-terraform-state -l uaenorth
  #   2. Create a storage account:
  #      az storage account create -n <unique_name> -g rg-terraform-state -l uaenorth --sku Standard_LRS
  #   3. Create a blob container:
  #      az storage container create -n tfstate --account-name <unique_name>
  #   4. Uncomment the backend block below and fill in the values.
  #   5. Run: terraform init -migrate-state
  #
  # backend "azurerm" {
  #   resource_group_name  = "rg-terraform-state"
  #   storage_account_name = "<unique_name>"
  #   container_name       = "tfstate"
  #   key                  = "graph-mcp-gateway.tfstate"
  # }
}

provider "azurerm" {
  features {}
}

variable "project" {
  type    = string
  default = "graph-mcp-gw"
}

variable "location" {
  type    = string
  default = "uaenorth"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "graph_mcp_client_id" {
  type      = string
  sensitive = true
}

variable "graph_mcp_tenant_id" {
  type      = string
  sensitive = true
}

variable "container_image" {
  type        = string
  description = "Full container image reference (e.g., <name>.azurecr.io/graph-mcp-gateway:latest)"
}

variable "users" {
  type        = list(string)
  default     = []
  description = "List of user names to deploy individual gateway instances for (e.g., [\"alice\", \"bob\"])"
}

variable "vnet_address_space" {
  type    = string
  default = "10.0.0.0/16"
}

locals {
  name_prefix = "${var.project}-${var.environment}"
  # Storage account names: 3-24 chars, lowercase alphanumeric only
  storage_name = substr(replace(lower("st${var.project}${var.environment}"), "-", ""), 0, 24)
  tags = {
    project     = var.project
    environment = var.environment
    managed_by  = "terraform"
  }
}

# ─── Resource Group ──────────────────────────────────────
resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name_prefix}"
  location = var.location
  tags     = local.tags
}

# ─── Virtual Network ────────────────────────────────────
resource "azurerm_virtual_network" "main" {
  name                = "vnet-${local.name_prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = [var.vnet_address_space]
  tags                = local.tags
}

# Subnet for Container Apps Environment
resource "azurerm_subnet" "container_apps" {
  name                 = "snet-container-apps"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [cidrsubnet(var.vnet_address_space, 7, 0)] # /23

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# Subnet for private endpoints (ACR, Storage)
resource "azurerm_subnet" "private_endpoints" {
  name                 = "snet-private-endpoints"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [cidrsubnet(var.vnet_address_space, 8, 2)] # /24
}

# ─── Private DNS Zones ──────────────────────────────────
resource "azurerm_private_dns_zone" "acr" {
  name                = "privatelink.azurecr.io"
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "acr" {
  name                  = "acr-dns-link"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.acr.name
  virtual_network_id    = azurerm_virtual_network.main.id
}

resource "azurerm_private_dns_zone" "storage" {
  name                = "privatelink.file.core.windows.net"
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "storage" {
  name                  = "storage-dns-link"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.storage.name
  virtual_network_id    = azurerm_virtual_network.main.id
}

# ─── Azure Container Registry (Premium for private endpoint) ─
resource "azurerm_container_registry" "main" {
  name                          = replace("acr${local.name_prefix}", "-", "")
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  sku                           = "Premium"
  admin_enabled                 = false
  public_network_access_enabled = false
  tags                          = local.tags
}

resource "azurerm_private_endpoint" "acr" {
  name                = "pe-acr-${local.name_prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "acr-connection"
    private_connection_resource_id = azurerm_container_registry.main.id
    subresource_names              = ["registry"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "acr-dns"
    private_dns_zone_ids = [azurerm_private_dns_zone.acr.id]
  }
}

# ─── Log Analytics ───────────────────────────────────────
resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.name_prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

# ─── Container Apps Environment (internal, VNet-integrated) ─
resource "azurerm_container_app_environment" "main" {
  name                           = "cae-${local.name_prefix}"
  location                       = azurerm_resource_group.main.location
  resource_group_name            = azurerm_resource_group.main.name
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id       = azurerm_subnet.container_apps.id
  internal_load_balancer_enabled = true
  tags                           = local.tags
}

# ─── Storage Account (private endpoint) ─────────────────
resource "azurerm_storage_account" "main" {
  name                          = local.storage_name
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  account_tier                  = "Standard"
  account_replication_type      = "LRS"
  public_network_access_enabled = false
  tags                          = local.tags
}

resource "azurerm_private_endpoint" "storage" {
  name                = "pe-storage-${local.name_prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "storage-connection"
    private_connection_resource_id = azurerm_storage_account.main.id
    subresource_names              = ["file"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "storage-dns"
    private_dns_zone_ids = [azurerm_private_dns_zone.storage.id]
  }
}

# ─── Per-user file shares ────────────────────────────────
resource "azurerm_storage_share" "user" {
  for_each = toset(var.users)

  name               = "data-${each.key}"
  storage_account_id = azurerm_storage_account.main.id
  quota              = 1 # 1 GB
}

resource "azurerm_container_app_environment_storage" "user" {
  for_each = toset(var.users)

  name                         = "data-${each.key}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  account_name                 = azurerm_storage_account.main.name
  access_key                   = azurerm_storage_account.main.primary_access_key
  share_name                   = azurerm_storage_share.user[each.key].name
  access_mode                  = "ReadWrite"
}

# ─── Per-user Container App (internal only) ──────────────
resource "azurerm_container_app" "gateway" {
  for_each = toset(var.users)

  name                         = "ca-${local.name_prefix}-${each.key}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = merge(local.tags, { user = each.key })

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = "system"
  }

  identity {
    type = "SystemAssigned"
  }

  template {
    min_replicas = 0
    max_replicas = 1

    container {
      name   = "gateway"
      image  = var.container_image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name        = "GRAPH_MCP_CLIENT_ID"
        secret_name = "graph-mcp-client-id"
      }
      env {
        name        = "GRAPH_MCP_TENANT_ID"
        secret_name = "graph-mcp-tenant-id"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "PORT"
        value = "3000"
      }

      volume_mounts {
        name = "data"
        path = "/home/node/m365-graph-mcp-gateway"
      }

      liveness_probe {
        transport        = "HTTP"
        path             = "/health"
        port             = 3000
        initial_delay    = 10
        interval_seconds = 30
      }

      startup_probe {
        transport               = "HTTP"
        path                    = "/health"
        port                    = 3000
        interval_seconds        = 5
        failure_count_threshold = 12
      }

      readiness_probe {
        transport        = "HTTP"
        path             = "/health"
        port             = 3000
        initial_delay    = 5
        interval_seconds = 10
      }
    }

    volume {
      name         = "data"
      storage_name = azurerm_container_app_environment_storage.user[each.key].name
      storage_type = "AzureFile"
    }
  }

  secret {
    name  = "graph-mcp-client-id"
    value = var.graph_mcp_client_id
  }

  secret {
    name  = "graph-mcp-tenant-id"
    value = var.graph_mcp_tenant_id
  }

  ingress {
    external_enabled = false
    target_port      = 3000
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# Grant each Container App pull access to ACR
resource "azurerm_role_assignment" "acr_pull" {
  for_each = toset(var.users)

  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_container_app.gateway[each.key].identity[0].principal_id
}

# ─── Outputs ─────────────────────────────────────────────
output "gateway_urls" {
  description = "Internal FQDNs (accessible only within the VNet)"
  value = {
    for user, app in azurerm_container_app.gateway :
    user => "https://${app.ingress[0].fqdn}"
  }
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "vnet_id" {
  value = azurerm_virtual_network.main.id
}
