FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The host: Slack bot, inbox, draft store. The agent itself runs in Modal Sandboxes,
# so this image holds no Claude Code binary path and no Agent Vault proxy.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
# Read at runtime relative to the app root (see config.ts APP_ROOT); dist/ and
# these are also what each sandbox receives.
COPY web ./web
COPY knowledge ./knowledge
COPY mcp-servers.json ./
COPY templates ./templates
ENV AGENT_RUNNER=modal
RUN chown -R node:node /app
USER node
# Host secrets (Modal token, machine identity, Slack tokens, CA fingerprint) come
# from the platform's env or `infisical run`; see README "Run it".
CMD ["node", "dist/slack.js"]
