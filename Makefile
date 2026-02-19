.PHONY: help build dev start login user docker-build docker-up docker-down docker-logs

help:
	@echo "m365-graph-mcp-gateway commands"
	@echo "make build       Build TypeScript"
	@echo "make dev         Run in watch mode"
	@echo "make start       Run built server"
	@echo "make login       Run device-code login"
	@echo "make user        Show current authenticated user"
	@echo "make docker-build Build Docker image"
	@echo "make docker-up   Start Docker service"
	@echo "make docker-down Stop Docker service"
	@echo "make docker-logs Tail Docker logs"

build:
	npm run build

dev:
	npm run dev

start:
	npm run start

login:
	npm run login

user:
	node dist/index.js --user

docker-build:
	docker compose build

docker-up:
	docker compose up -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f m365-graph-mcp-gateway
