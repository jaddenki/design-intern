# Architecture notes

Design Intern is a Claude Agent SDK agent (from Infisical's agent-template) that drafts approval-gated weekly design updates. The host (Slack bot, inbox, draft store) runs each agent turn in a disposable Modal Sandbox (`src/sandbox/`, after Infisical/modal-agent) with no public egress. The sandbox's only way out is an Agent Vault proxy sidecar that swaps placeholder tokens for real credentials. README "Architecture" has the diagram.

## Entry points

- `src/slack.ts`: Slack Socket Mode bot. It is the Dockerfile `CMD` and also starts the web server and weekly schedule.
- `src/web-main.ts`: the inbox without Slack (`npm run web`).
- `src/sandbox/entry.ts`: runs inside the sandbox; reads one job on stdin, prints events.
- `src/index.ts`: CLI. `npm start "question"` or `npm run draft`.
- `src/eval/run-eval.ts`: fixture eval (`npm run eval`).

Each one imports `./bootstrap.js` first (the eval's fixture scope when `DATA_SOURCE=fixtures`, which only the eval and tests set; there is no demo mode). Config comes from Infisical Secrets Manager via `infisical run` (see the Makefile); there is no `.env`. `AGENT_RUNNER=modal` (set by every make target) runs turns in Modal; unset, `runInProcess` runs them on the host, which tests use.

## Invariants (don't break these)

1. **No agent write path to Slack.** The agent's only writes are `submit_draft` / `revise_draft`, which save a *pending* draft. Posting happens only in `drafts/actions.ts → approveDraft()`, called from a human click. Don't add a posting tool.
2. **Drafts cite only seen sources.** Source tools call `recordSource(ctx, …)`. `drafts/validate.ts` rejects any cited id not in `ctx.sources`. Every new source tool must record what it returns and print a `source_id:` line.
3. **Scope lives in the client.** Each `client.ts` reads its allowlist from env and filters results again after fetching. Tools take no scope arguments.
4. **Third-party text is fenced.** Wrap any human-written content in `untrusted(sourceId, body)`.
5. **Servers are built per run** (`agent.ts → buildServers(ctx)`) so concurrent runs don't share a `RunContext`. Tools are factories `(ctx) => tool(...)`.

## Layout

```
src/
├── linear/ github/ slack-source/   client.ts (scope + fetch + fixtures) and tools/
├── knowledge/                       design reference docs from DESIGN_KNOWLEDGE_DIR
├── drafts/                          types, store (JSON files), validate, render, actions, tools/
├── external-mcp.ts                  mcp-servers.json loader + scope/source hooks
├── figma/fixture-server.ts          eval stand-in with the same tool name as Framelink
├── web/server.ts + web/             approval inbox (vanilla HTML/CSS/JS, no build)
├── slack-approval.ts                approval preview blocks + the one posting function
├── run-agent.ts prompt.ts agent.ts  agent loop, system prompt, server factory
├── sandbox/                         AGENT_RUNNER=modal: Modal Sandbox runner, entry, host-side draft checks
└── schedule.ts                      weekly timer
fixtures/                            fictional eval week + expected.json ground truth
```

## Gotchas

1. **`@slack/web-api` ignores `HTTPS_PROXY`.** Use `slackClient()` / `slackAgent` from `src/slack-client.ts`, which pass an explicit `HttpsProxyAgent`. Never pass a per-call `token` (it goes in the body, which the proxy can't rewrite).
2. **The SDK picks the wrong native binary on glibc Linux.** See [anthropics/claude-agent-sdk-typescript#296](https://github.com/anthropics/claude-agent-sdk-typescript/issues/296). The sandbox pins `CLAUDE_CODE_EXECUTABLE` (`CLAUDE_BINARY` in `src/sandbox/image.ts`).
3. Runtime files (`web/`, `knowledge/`, `mcp-servers.json`) are read relative to the app root. Copy new ones in the Dockerfile, and add agent-side ones to `bundled()` in `src/sandbox/image.ts`. New npm dependencies land in the sandbox image automatically (pinned from package-lock).
4. **Sandbox output is untrusted.** Draft tools write through `ctx.drafts` (a `DraftSink`). In the sandbox that's memory, and `src/sandbox/accept.ts` re-validates before the host saves. Never let the sandbox write the store directly.
5. New credential env vars must be added to `PLACEHOLDERS` in `src/sandbox/job.ts`, or the sandbox won't see them. Never forward a host value.

## Runtime user

The agent runs as `user` (uid 2000) in the sandbox, not root: the `claude` binary refuses `bypassPermissions` under root.

## Where to make changes

| Want to change... | Edit... |
|---|---|
| Persona / drafting rules | `src/prompt.ts` |
| Models | `DRAFT_MODEL` / `CHAT_MODEL` env, defaults in `src/config.ts` |
| Add a native source | `src/<service>/client.ts` + `tools/`, register in `src/agent.ts`, label in `run-agent.ts` |
| Add a third-party MCP server | `mcp-servers.json` only |
| Update sections | `src/drafts/types.ts` (`SECTIONS`) and `web/app.js` |
| Approval message | `src/slack-approval.ts` |
| Inbox UI | `web/` |
