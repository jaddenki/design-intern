.PHONY: help web draft ask slack eval test check-init bootstrap-secrets sync-brand sandboxes runs

# Host config and host credentials come from Infisical Secrets Manager (`infisical run`).
# Every agent turn runs in a Modal Sandbox whose only way out is an Agent Proxy sidecar.
SECRETS_ENV ?= dev
SECRETS_PATH ?= /
INBOX_PASSWORD ?= demo

# --recursive reads every folder under SECRETS_PATH (host/, agent/, scope/, config/).
RUN = npm run build >/dev/null && infisical run --env=$(SECRETS_ENV) --path=$(SECRETS_PATH) --recursive -- env AGENT_RUNNER=modal

help:
	@echo "make web            inbox at localhost:3000 (any name, password: $(INBOX_PASSWORD))"
	@echo "make draft          draft this week's update (NOTE='what I worked on' adds a check-in)"
	@echo "make ask Q='...'    one-off question from the CLI"
	@echo "make slack          run the Slack bot (also serves the inbox)"
	@echo "make eval RUNS=3    score drafts on the fictional eval week (fixtures/expected.json)"
	@echo "make test           unit tests (no Infisical or Modal needed)"
	@echo "make sandboxes      running sandboxes, with the model each one uses"
	@echo "make runs           the last 10 runs: model, time, tools, outcome (N=20 for more)"
	@echo "make sync-brand     pull brand guidelines and logos into knowledge/brand/ (uses your gh login)"
	@echo ""
	@echo "make bootstrap-secrets   seed the Secrets Manager project with placeholders and defaults"
	@echo "Secrets: env=$(SECRETS_ENV) path=$(SECRETS_PATH)"

check-init:
	@test -f .infisical.yaml -o -f .infisical.json || { echo "Link this repo to your Secrets Manager project first: infisical init"; exit 1; }

web: check-init
	$(RUN) WEB_ACCESS_PASSWORD=$(INBOX_PASSWORD) npm run web

draft: check-init
	$(RUN) npm run draft $(if $(NOTE),-- "$(NOTE)")

ask: check-init
	@test -n "$(Q)" || { echo "Usage: make ask Q='What are our brand colors?'"; exit 1; }
	$(RUN) npm start -- "$(Q)"

slack: check-init
	$(RUN) npm run start:slack

eval: check-init
	$(RUN) npm run eval -- --runs $(or $(RUNS),1)

test:
	npm test

sandboxes: check-init
	@infisical run --env=$(SECRETS_ENV) --path=$(SECRETS_PATH) --recursive --silent -- npx tsx scripts/sandboxes.ts

runs:
	@npx tsx scripts/runs.ts $(N)

sync-brand:
	npx tsx scripts/sync-brand.ts

# Folders by sensitivity: host/ holds the only real credentials; agent/ holds placeholders
# (real values live in the Agent Vault bundle); scope/ and config/ hold plain settings.
bootstrap-secrets: check-init
	-@for f in host agent scope config; do infisical secrets folders create --env=$(SECRETS_ENV) --path=/ --name=$$f >/dev/null 2>&1; done
	infisical secrets set --env=$(SECRETS_ENV) --path=/agent \
	  LINEAR_API_KEY=__linear_api_key__ \
	  GITHUB_TOKEN=__github_token__ \
	  FIGMA_API_KEY=__figma_api_key__
	infisical secrets set --env=$(SECRETS_ENV) --path=/config \
	  AGENT_VAULT_ACCESS_BUNDLE=design-intern \
	  AGENT_VAULT_PROXY_SECRET=design-intern-proxy \
	  DESIGN_ALLOWLIST=jadden@infisical.com
	@echo ""
	@echo "Now set these in the Infisical dashboard ($(SECRETS_ENV)):"
	@echo "  /host:   MODAL_TOKEN_ID, MODAL_TOKEN_SECRET, INFISICAL_UNIVERSAL_AUTH_CLIENT_ID,"
	@echo "           INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET, SLACK_BOT_TOKEN, SLACK_APP_TOKEN"
	@echo "  /config: AGENT_VAULT_CA_FINGERPRINT, DESIGN_APPROVAL_CHANNEL, DESIGN_UPDATE_CHANNEL"
	@echo "  /scope:  LINEAR_ASSIGNEE_EMAILS and/or LINEAR_TEAM_KEYS, GITHUB_REPOS + DESIGN_GITHUB_LOGINS,"
	@echo "           FIGMA_PROJECT_IDS, DESIGN_SLACK_CHANNELS"
