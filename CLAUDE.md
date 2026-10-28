# Architecture notes

This is a scaffolding repo for Claude Agent SDK agents that run behind Infisical's [agent-vault](https://github.com/infisical/agent-vault) proxy. Below is the layout future maintainers and Claude Code sessions should know.

## Entry points

- `src/index.ts` — one-shot CLI. Reads a prompt from argv, calls `runAgent()`, prints the response. Useful for local development and testing.
- `src/slack.ts` — Slack Socket Mode server. The Dockerfile's default `CMD`. Handles `app_mention` (channel @mentions) and DMs (`message` with `channel_type === "im"`), maintains thread context, posts a "Thinking..." placeholder and updates it with the final response. Health check on `GET /health`.

Both entry points call `runAgent()` from `src/run-agent.ts`.

## Agent core

`src/run-agent.ts` wraps the SDK's `query()` async iterator. This is where the **system prompt**, **model**, and **MCP server registration** live. `runAgent()` also accepts an optional `onProgress(message)` callback so the Slack handler can update its "Thinking..." placeholder while tools run.

## Tools

Tools live in `src/tools/` and are registered in `src/agent.ts` via `createSdkMcpServer`. Each tool is exposed to the agent as `mcp__<server-name>__<tool-name>`, and `runAgent()`'s `allowedTools` glob must match (default: `mcp__agent__*`).

**Growing past 1–2 tools:** group by service. For example, a real integration would look like:

```
src/
├── linear/
│   ├── client.ts          ← per-service HTTP client (auth, base URL)
│   ├── types.ts           ← shared response types
│   └── tools/
│       ├── index.ts
│       ├── list-issues.ts
│       └── create-issue.ts
└── agent.ts               ← imports tools, registers them
```

See [`talent-agent`](https://github.com/infisical/talent-agent)'s `src/ashby/` directory for a worked example.

## agent-vault wiring

Outgoing HTTPS requests go through a local MITM proxy that swaps placeholder tokens for real credentials. The Dockerfile and `slack.ts` handle two gotchas:

1. **`@slack/web-api` ignores `HTTPS_PROXY`** — it hardcodes `proxy: false` on its axios client. `src/slack.ts` works around this by passing an explicit `HttpsProxyAgent` via `clientOptions.agent`. Keep this when adding new HTTP clients that may have the same behavior (axios-based libraries are common offenders).
2. **The SDK picks the wrong native binary on glibc Linux** — see [anthropics/claude-agent-sdk-typescript#296](https://github.com/anthropics/claude-agent-sdk-typescript/issues/296). The Dockerfile pins `CLAUDE_CODE_EXECUTABLE` to the glibc binary, and `run-agent.ts` reads that env var when calling `query()`.

## Runtime user

The container runs as the unprivileged `node` user, not root. The `claude` binary refuses `--permission-mode bypassPermissions` under root, and we need `bypassPermissions` because tool calls are gated by the agent itself, not by interactive approval. Don't switch back to root.

## Where to make changes

| Want to change... | Edit... |
|---|---|
| Agent persona / instructions | `src/run-agent.ts` (`systemPrompt`) |
| Model | `src/run-agent.ts` (`model`) |
| Add a tool | New file in `src/tools/`, register in `src/agent.ts` |
| MCP server name | `src/agent.ts` (`name`) + `src/run-agent.ts` (`mcpServers` key + `allowedTools` glob) |
| Slack greeting / display name | `src/slack.ts` (TODO comments) |
| Per-tool progress label in Slack | `src/run-agent.ts` (`toolProgressLabel`) |
| Container start command | `Dockerfile` (`CMD`) |
