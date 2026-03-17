.PHONY: help build dev start login login-device user ci \
       docker-build docker-up docker-down docker-logs smoke \
       deploy deploy-secrets add-user remove-user login-user smoke-user \
       deploy-status deploy-logs deploy-plan deploy-destroy

help:
	@echo "m365-graph-mcp-gateway"
	@echo ""
	@echo "Local:"
	@echo "  make build              Build TypeScript"
	@echo "  make dev                Watch mode"
	@echo "  make start              Run server"
	@echo "  make login              Interactive browser login"
	@echo "  make login-device       Device code login (headless)"
	@echo "  make user               Show authenticated user"
	@echo "  make ci                 Lint + format + build + test"
	@echo ""
	@echo "Docker:"
	@echo "  make docker-build       Build image"
	@echo "  make docker-up          Start"
	@echo "  make docker-down        Stop"
	@echo "  make docker-logs        Tail logs"
	@echo "  make smoke              Run smoke tests"
	@echo ""
	@echo "Deploy (ENV=prod by default, override with ENV=dev):"
	@echo "  make deploy                Init infra + build image"
	@echo "  make deploy-secrets        Seed Key Vault from .env"
	@echo "  make add-user U=x          Deploy Container App for user"
	@echo "  make add-user U=x ENV=dev  Deploy to dev environment"
	@echo "  make remove-user U=x       Remove user's Container App"
	@echo "  make login-user U=x        Device-code auth for user"
	@echo "  make smoke-user U=x        Remote smoke test (health, tools, find)"
	@echo "  make deploy-status [U=x]   Show deployment status"
	@echo "  make deploy-logs U=x       Tail user's logs"
	@echo "  make deploy-plan           Dry-run: show what exists / missing"
	@echo "  make deploy-destroy        Delete everything"

# ── Local ─────────────────────────────────────────────────────────────────

build:
	npm run build

dev:
	npm run dev

start:
	npm run start

login:
	npm run login

login-device:
	npm run login:device

user:
	node dist/index.js --user

ci:
	npm run ci

# ── Docker ────────────────────────────────────────────────────────────────

docker-build:
	docker compose build

docker-up:
	docker compose up -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f m365-graph-mcp-gateway

smoke:
	bash scripts/test-all-tools.sh

# ── Deploy (sources .env.azure.$(ENV)) ───────────────────────────────────

ENV ?= prod
AZURE_ENV_FILE = .env.azure.$(ENV)

deploy:
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@echo "▸ Deploying to [$(ENV)] using $(AZURE_ENV_FILE)"
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh init
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh build

deploy-secrets:
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@echo "▸ Seeding secrets for [$(ENV)] using $(AZURE_ENV_FILE)"
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh secrets

add-user:
	@[ -n "$(U)" ] || { echo "Usage: make add-user U=jdoe [ENV=prod]"; exit 1; }
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@echo "▸ Adding user '$(U)' to [$(ENV)] using $(AZURE_ENV_FILE)"
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh add $(U)

remove-user:
	@[ -n "$(U)" ] || { echo "Usage: make remove-user U=jdoe [ENV=prod]"; exit 1; }
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@echo "▸ Removing user '$(U)' from [$(ENV)] using $(AZURE_ENV_FILE)"
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh remove $(U)

login-user:
	@[ -n "$(U)" ] || { echo "Usage: make login-user U=jdoe [ENV=prod]"; exit 1; }
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@echo "▸ Logging in user '$(U)' on [$(ENV)] using $(AZURE_ENV_FILE)"
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh login $(U)

smoke-user:
	@[ -n "$(U)" ] || { echo "Usage: make smoke-user U=jdoe [ENV=prod]"; exit 1; }
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@echo "▸ Smoke testing '$(U)' on [$(ENV)] using $(AZURE_ENV_FILE)"
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh smoke $(U)

deploy-status:
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@echo "▸ Status for [$(ENV)] using $(AZURE_ENV_FILE)"
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh status $(U)

deploy-logs:
	@[ -n "$(U)" ] || { echo "Usage: make deploy-logs U=jdoe [ENV=prod]"; exit 1; }
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@echo "▸ Logs for '$(U)' on [$(ENV)] using $(AZURE_ENV_FILE)"
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh logs $(U)

deploy-plan:
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@echo "▸ Plan for [$(ENV)] using $(AZURE_ENV_FILE)"
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh plan

deploy-destroy:
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@echo "▸ Destroying [$(ENV)] using $(AZURE_ENV_FILE)"
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh destroy
