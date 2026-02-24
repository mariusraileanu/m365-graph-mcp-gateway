.PHONY: help build dev start login login-device user ci \
       docker-build docker-up docker-down docker-logs smoke \
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
	@echo "Azure:"
	@echo "  make azure-init         Create shared infra (RG, ACR, KV, etc.)"
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

# ── Azure Container Apps ─────────────────────────────────────────────────

azure-init:
	bash scripts/azure.sh init

azure-plan:
	bash scripts/azure.sh plan

azure-build:
	bash scripts/azure.sh build $(TAG)

azure-secrets:
	bash scripts/azure.sh secrets

azure-add:
	@[ -n "$(U)" ] || (echo "Usage: make azure-add U=mlucian" && exit 1)
	bash scripts/azure.sh add $(U)

azure-remove:
	@[ -n "$(U)" ] || (echo "Usage: make azure-remove U=mlucian" && exit 1)
	bash scripts/azure.sh remove $(U)

azure-login:
	@[ -n "$(U)" ] || (echo "Usage: make azure-login U=mlucian" && exit 1)
	bash scripts/azure.sh login $(U)

azure-status:
	bash scripts/azure.sh status $(U)

azure-logs:
	@[ -n "$(U)" ] || (echo "Usage: make azure-logs U=mlucian" && exit 1)
	bash scripts/azure.sh logs $(U)

azure-destroy:
	bash scripts/azure.sh destroy
