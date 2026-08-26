# Taiwan Dark Chess — common tasks

.DEFAULT_GOAL := help

SITE_URL := https://dark-chess.gh.miniasp.com
REPO     := doggy8088/dark-chess

# Cloud Run (online multiplayer)
GCP_PROJECT := vertex-ai-sprint
GCP_REGION  := asia-east1
RUN_SERVICE := dark-chess

.PHONY: help install dev dev-server test watch typecheck build preview clean deploy status open start-local deploy-run logs-run open-run

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies (npm ci)
	npm ci

dev: ## Start Vite dev server
	npm run dev

dev-server: ## Start the game server for local dev (run beside `make dev`)
	npm run dev:server

start-local: ## Build everything and serve the production bundle locally
	npm run build && npm run build:server
	FIRESTORE_ENABLED=0 PORT=8787 npm start

test: ## Run rule-engine unit tests once
	npm test

watch: ## Run unit tests in watch mode
	npx vitest

typecheck: ## Type-check without emitting
	npm run typecheck

build: ## Type-check + production build
	npm run build

preview: build ## Serve the production build locally
	npm run preview

clean: ## Remove build output and node_modules
	rm -rf dist dist-server node_modules

deploy-run: ## Deploy the online-multiplayer service to Cloud Run
	gcloud run deploy $(RUN_SERVICE) --source . \
	  --project $(GCP_PROJECT) --region $(GCP_REGION) \
	  --allow-unauthenticated --session-affinity \
	  --timeout 3600 --min-instances 0 --max-instances 1 \
	  --memory 512Mi --port 8080

logs-run: ## Tail Cloud Run service logs
	gcloud run services logs read $(RUN_SERVICE) --region $(GCP_REGION) --project $(GCP_PROJECT) --limit 50

open-run: ## Open the Cloud Run deployment in the browser
	open $$(gcloud run services describe $(RUN_SERVICE) --region $(GCP_REGION) --project $(GCP_PROJECT) --format 'value(status.url)')

deploy: test build ## Push main to GitHub (triggers Pages deployment)
	git push origin main
	gh run watch --repo $(REPO) --exit-status $$(gh run list --repo $(REPO) --limit 1 --json databaseId -q '.[0].databaseId')

status: ## Show latest GitHub Pages deployment runs
	gh run list --repo $(REPO) --limit 5

open: ## Open the live site in the browser
	open $(SITE_URL)
