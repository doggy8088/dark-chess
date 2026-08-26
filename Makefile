# Taiwan Dark Chess — common tasks

.DEFAULT_GOAL := help

SITE_URL := https://dark-chess.gh.miniasp.com
REPO     := doggy8088/dark-chess

.PHONY: help install dev test watch typecheck build preview clean deploy status open

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies (npm ci)
	npm ci

dev: ## Start Vite dev server
	npm run dev

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
	rm -rf dist node_modules

deploy: test build ## Push main to GitHub (triggers Pages deployment)
	git push origin main
	gh run watch --repo $(REPO) --exit-status $$(gh run list --repo $(REPO) --limit 1 --json databaseId -q '.[0].databaseId')

status: ## Show latest GitHub Pages deployment runs
	gh run list --repo $(REPO) --limit 5

open: ## Open the live site in the browser
	open $(SITE_URL)
