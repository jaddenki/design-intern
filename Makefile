.PHONY: help web draft ask slack eval test check-init bootstrap-secrets

# Host config and host credentials come from Infisical Secrets Manager (`infisical run`).
# Every agent turn runs in a Modal Sandbox whose only way out is an Agent Proxy sidecar.
SECRETS_ENV ?= dev
SECRETS_PATH ?= /
INBOX_PASSWORD ?= demo

RUN = npm run build >/dev/null && infisical run --env=$(SECRETS_ENV) --path=$(SECRETS_PATH) -- env AGENT_RUNNER=modal

help:
	@echo "make web            inbox at localhost:3000 (any name, password: $(INBOX_PASSWORD))"
	@echo "make draft          draft this week's update from the CLI"
	@echo "make ask Q='...'    one-off question from the CLI"
	@echo "make slack          run the Slack bot (also serves the inbox)"
	@echo "make eval RUNS=3    score drafts on the fictional eval week (fixtures/expected.json)"
	@echo "make test           unit tests (no Infisical or Modal needed)"
	@echo ""
	@echo "make bootstrap-secrets   seed the Secrets Manager project with placeholders and defaults"
	@echo "Secrets: env=$(SECRETS_ENV) path=$(SECRETS_PATH)"

check-init:
	@test -f .infisical.yaml -o -f .infisical.json || { echo "Link this repo to your Secrets Manager project first: infisical init"; exit 1; }

web: check-init
	$(RUN) WEB_ACCESS_PASSWORD=$(INBOX_PASSWORD) npm run web

draft: check-init
	$(RUN) npm run draft

ask: check-init
	@test -n "$(Q)" || { echo "Usage: make ask Q='What are our brand colors?'"; exit 1; }
	$(RUN) npm start -- "$(Q)"

slack: check-init
	$(RUN) npm run start:slack

eval: check-init
	$(RUN) npm run eval -- --runs $(or $(RUNS),1)

test:
	npm test

# Agent credentials are placeholders only: the real values live in the Agent Vault bundle.
bootstrap-secrets: check-init
	infisical secrets set --env=$(SECRETS_ENV) --path=$(SECRETS_PATH) \
	  LINEAR_API_KEY=__linear_api_key__ \
	  GITHUB_TOKEN=__github_token__ \
	  FIGMA_API_KEY=__figma_api_key__ \
	  AGENT_VAULT_ACCESS_BUNDLE=design-intern \
	  AGENT_VAULT_PROXY_SECRET=design-intern-proxy \
	  DESIGN_ALLOWLIST=jadden@infisical.com
	@echo ""
	@echo "Now set these in the Infisical dashboard ($(SECRETS_ENV), $(SECRETS_PATH)):"
	@echo "  Host:   MODAL_TOKEN_ID, MODAL_TOKEN_SECRET, INFISICAL_UNIVERSAL_AUTH_CLIENT_ID,"
	@echo "          INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET, AGENT_VAULT_CA_FINGERPRINT"
	@echo "  Scope:  LINEAR_ASSIGNEE_EMAILS and/or LINEAR_TEAM_KEYS, GITHUB_REPOS + DESIGN_GITHUB_LOGINS,"
	@echo "          FIGMA_PROJECT_IDS, DESIGN_SLACK_CHANNELS"
	@echo "Slack bot: real SLACK_BOT_TOKEN and SLACK_APP_TOKEN (host credentials)."
