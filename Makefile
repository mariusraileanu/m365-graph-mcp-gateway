.PHONY: help build dev start login user ci docker-build docker-up docker-down docker-logs smoke deploy

help:
	@echo "m365-graph-mcp-gateway commands"
	@echo "make build         Build TypeScript"
	@echo "make dev           Run in watch mode"
	@echo "make start         Run built server"
	@echo "make login         Interactive browser login"
	@echo "make login-device  Device code login (headless)"
	@echo "make user          Show current authenticated user"
	@echo "make ci            Run lint + format + build + test"
	@echo "make docker-build  Build Docker image"
	@echo "make docker-up     Start Docker service"
	@echo "make docker-down   Stop Docker service"
	@echo "make docker-logs   Tail Docker logs"
	@echo "make smoke         Run smoke tests against running gateway"
	@echo "make deploy        Deploy to Azure (requires CONTAINER_IMAGE)"

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

deploy:
	bash scripts/deploy.sh
