.PHONY: help build dev start login login-device user ci \
       docker-build docker-up docker-down docker-logs smoke \
       deploy add-user remove-user login-user deploy-status deploy-logs deploy-plan deploy-destroy \
       azure-init azure-plan azure-build azure-secrets azure-add azure-remove \
       azure-login azure-status azure-logs azure-destroy

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
	@echo "Deploy (sources .env.azure.\$$(ENV), default ENV=prod):"
	@echo "  make deploy             Init infra + build image"
	@echo "  make add-user U=x       Deploy Container App for user"
	@echo "  make remove-user U=x    Remove user's Container App"
	@echo "  make login-user U=x     Device-code auth for user"
	@echo "  make deploy-status [U=x] Show deployment status"
	@echo "  make deploy-logs U=x    Tail user's logs"
	@echo "  make deploy-plan        Dry-run: show what exists / missing"
	@echo "  make deploy-destroy     Delete everything"
	@echo ""
	@echo "Azure (low-level, uses env vars or script defaults):"
	@echo "  make azure-init         Create shared infra"
	@echo "  make azure-plan         Show what exists / missing"
	@echo "  make azure-build        Build & push image to ACR"
	@echo "  make azure-secrets      Seed Key Vault from .env"
	@echo "  make azure-add U=x      Deploy Container App for user"
	@echo "  make azure-remove U=x   Remove user's Container App"
	@echo "  make azure-login U=x    Device-code auth for user"
	@echo "  make azure-status [U=x] Show Container Apps (all or one)"
	@echo "  make azure-logs U=x     Tail user's logs"
	@echo "  make azure-destroy      Delete everything"

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

define source-azure
	@test -f $(AZURE_ENV_FILE) \
	  || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	@set -a; . ./$(AZURE_ENV_FILE); set +a
endef

deploy:
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh init
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh build

add-user:
	@[ -n "$(U)" ] || { echo "Usage: make add-user U=jdoe [ENV=prod]"; exit 1; }
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh add $(U)

remove-user:
	@[ -n "$(U)" ] || { echo "Usage: make remove-user U=jdoe [ENV=prod]"; exit 1; }
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh remove $(U)

login-user:
	@[ -n "$(U)" ] || { echo "Usage: make login-user U=jdoe [ENV=prod]"; exit 1; }
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh login $(U)

deploy-status:
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh status $(U)

deploy-logs:
	@[ -n "$(U)" ] || { echo "Usage: make deploy-logs U=jdoe [ENV=prod]"; exit 1; }
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh logs $(U)

deploy-plan:
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh plan

deploy-destroy:
	@test -f $(AZURE_ENV_FILE) || { echo "Missing $(AZURE_ENV_FILE) — copy from .env.azure.example"; exit 1; }
	set -a; . ./$(AZURE_ENV_FILE); set +a; bash scripts/azure.sh destroy

# ── Azure (low-level) ────────────────────────────────────────────────────

azure-init:
	bash scripts/azure.sh init

azure-plan:
	bash scripts/azure.sh plan

azure-build:
	bash scripts/azure.sh build $(TAG)

azure-secrets:
	bash scripts/azure.sh secrets

azure-add:
	@[ -n "$(U)" ] || (echo "Usage: make azure-add U=jdoe" && exit 1)
	bash scripts/azure.sh add $(U)

azure-remove:
	@[ -n "$(U)" ] || (echo "Usage: make azure-remove U=jdoe" && exit 1)
	bash scripts/azure.sh remove $(U)

azure-login:
	@[ -n "$(U)" ] || (echo "Usage: make azure-login U=jdoe" && exit 1)
	bash scripts/azure.sh login $(U)

azure-status:
	bash scripts/azure.sh status $(U)

azure-logs:
	@[ -n "$(U)" ] || (echo "Usage: make azure-logs U=jdoe" && exit 1)
	bash scripts/azure.sh logs $(U)

azure-destroy:
	bash scripts/azure.sh destroy
