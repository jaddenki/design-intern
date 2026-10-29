# Design Intern

Design Intern reads the design team's Linear, Slack, GitHub, and Figma activity, reconciles it into a weekly update, and puts that update in front of a human for approval. Nothing posts to Slack until someone clicks **Approve**. It also answers "why is X in the draft?" and design reference questions ("what are our brand colors?") from documented sources only.

It's built on the Claude Agent SDK. Following [Infisical/modal-agent](https://github.com/Infisical/modal-agent), every agent turn runs in a disposable Modal Sandbox with no internet access. Its only way out is an [Agent Vault](https://infisical.com/docs/documentation/platform/agent-vault/overview) proxy that adds credentials on the wire, so the agent never holds one.

## What you can ask

In Slack (@mention or DM) or in the web inbox's chat pane:

- "Draft this week's design update." → drafts, saves as pending, sends an approval preview. In the inbox it first asks what you worked on; that check-in becomes a source the draft can cite (`make draft NOTE='…'` from the CLI).
- In the preview's thread: "Why is the login redesign a risk?" / "Drop the icon line." → explains or revises the pending draft
- "What's our primary color?" / "Give me the white logo as SVG" → answers from the brand docs in `knowledge/` (filled by `make sync-brand`), with a copyable, previewed SVG. Anything undocumented, it says so.

## Architecture

```
 Your machine / server ("host")                         Modal, one Sandbox per agent turn
┌──────────────────────────────────┐                  ┌───────────────────────────────────────────┐
│ Slack bot · web inbox · schedule │  create, exec,   │ agent container (uid 2000, no egress)     │
│ draft store (data/) · approvals  │──terminate──────▶│   infisical agent-vault run -- node       │
│                                  │  stdin: session  │   dist/sandbox/entry.js  (Agent SDK loop, │
│ secrets from Secrets Manager:    │  token + job     │   Linear/GitHub/Slack/Figma/doc tools)    │
│  Modal token, machine identity,  │◀─────────────────│        │ only route out                   │
│  Slack tokens, CA fingerprint    │  NDJSON events:  │        ▼                                  │
│                                  │  progress, result│ sidecar "agent-proxy:17323"               │
│ re-validates drafts, saves them  │  + draft as data │   infisical agent-vault proxy             │
└───────────┬──────────────────────┘                  │   (proxy token from a Modal Secret)       │
            │ mint / revoke session                   └────────┬──────────────────────────────────┘
            ▼                                                  │ placeholder → real credential
      Infisical Agent Vault ◀──── settings, CA, session check ─┘──▶ api.anthropic.com, api.linear.app,
                                                                    api.github.com, api.figma.com, slack.com
```

One agent turn (`src/sandbox/runner.ts`):

1. The host mints an Agent Vault session over the `design-intern` bundle with its machine identity, while creating a Modal Sandbox with `outboundCidrAllowlist: []`.
2. It copies in the compiled app (about 60 KB; npm dependencies are baked into the image) and starts Agent Proxy as a sidecar. The proxy token goes only to the sidecar, through a Modal Secret.
3. It runs the agent as a non-root user under `infisical agent-vault run --ca-fingerprint=…`. The session token is the first line of stdin and the job JSON follows, so neither appears in the argv Modal records. The sandbox gets placeholders only (`__linear_api_key__` …, `src/sandbox/job.ts`).
4. The agent streams progress lines and one result. A draft comes back as data. The host re-checks its citations, rebuilds it with its own id and author, and saves it (`src/sandbox/accept.ts`).
5. The session is revoked and the sandbox terminated.

The host never runs the model or the tools. It holds the credentials it needs for itself: the Modal token, the machine identity, and the Slack bot's tokens for Socket Mode and posting approved updates.

## Run it

Config and host secrets come from an Infisical Secrets Manager project; there's no `.env` file. Link the repo once with `infisical init`, then `make bootstrap-secrets`.

```bash
make draft          # draft this week's update
make web            # inbox at localhost:3000 (any name, password from INBOX_PASSWORD, default "demo")
make slack          # Slack bot, also serves the inbox and runs the weekly schedule
make ask Q='...'    # one-off question
make eval RUNS=3    # score drafts on the eval week
make test           # unit tests, no Infisical or Modal needed
```

### One-time setup

1. **Agent Vault bundle `design-intern`** with services for Anthropic, Linear (`Authorization`), GitHub, Figma (`X-Figma-Token`), and Slack (`Authorization`), each swapping its placeholder for the real credential. Set the proxy's traffic policy to bundle hosts only.
2. **Proxy:** create one in Agent Vault and put its proxy token in a Modal Secret named `design-intern-proxy` under `INFISICAL_AGENT_VAULT_PROXY_TOKEN`.
3. **Machine identity** with Universal Auth that is a plain Agent Vault member granted only `design-intern`. An admin identity can mint sessions over any bundle.
4. **Secrets Manager:** `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`, `AGENT_VAULT_CA_FINGERPRINT` (the proxy's row on the Proxies page), the scope settings below, and, for the Slack bot, the real `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.

The first run builds the sandbox image, which takes a few minutes; Modal caches it after that.

Secrets Manager layout (the Makefile reads all folders with `--recursive`; keep each key in one folder only):

| Folder | What | Who should see it |
|---|---|---|
| `/host` | The only real credentials: Modal token, machine identity, Slack bot and app tokens | You and the deploy identity |
| `/agent` | Placeholders like `__linear_api_key__`; real values live in the Agent Vault bundle | Anyone on the project |
| `/scope` | Who and what the agent reads: Linear assignees and teams, GitHub repos and logins, Slack channels, Figma projects | Teammates who manage scope |
| `/config` | Bundle and proxy-secret names, CA fingerprint, allowlist, channels, schedule, models | Teammates who manage scope |

Run `make sync-brand` once (and whenever the brand changes) so brand questions have something to answer from. It pulls infisical.com/design.md, the brand CSS tokens, the logos, and the private brand repo's tokens via your `gh` login into the gitignored `knowledge/brand/`.

### Deploying

`Dockerfile` builds the host only (`node dist/slack.js`, `AGENT_RUNNER=modal`). Give it the host secrets through the platform's environment or `infisical run`, and a persistent disk at `/app/data` for drafts. It needs no inbound port for Slack (Socket Mode); the inbox listens on `PORT`.

Slack app scopes: `app_mentions:read`, `chat:write`, `im:history`, `channels:history`, `groups:history`, `channels:read`, `users:read`, `users:read.email`. Turn on Interactivity (Socket Mode handles it) for the Approve and Reject buttons. Invite the bot to every design channel plus the approval and update channels.

## The posted message

`templates/weekly-update.md` is the Slack message that posts on approval. `{{last_week}}` becomes last week's lines grouped by project (the agent picks short groups like "Website fixes"), `{{priorities}}` becomes the numbered "next" list, and `{{date_range}}` the window. Change the greeting, emoji, and layout there; `UPDATE_TEMPLATE` points somewhere else.

The inbox shows the exact message under each draft with a live preview. Edit it there before approving and your version posts instead; "Reset to template" goes back to the generated one.

## Scope

Each source fails closed when its scope is empty, and the model can't pass a scope argument.

- **Linear:** `LINEAR_ASSIGNEE_EMAILS` (issues assigned to these people) and/or `LINEAR_TEAM_KEYS`. With both set, an issue must match both. Add people as the team grows. The agent sees issues that changed this week plus open ones (todo or in progress) that didn't, and suggests up to three of those for "Up next".
- **GitHub:** `GITHUB_REPOS` plus `DESIGN_GITHUB_LOGINS` (PR authors).
- **Slack:** `DESIGN_SLACK_CHANNELS` (channel ids).
- **Figma:** `FIGMA_PROJECT_IDS` (every file in those folders) and/or `FIGMA_FILE_KEYS`.

Other settings: `DESIGN_APPROVAL_CHANNEL` (previews with buttons), `DESIGN_UPDATE_CHANNEL` (where approved updates post; unset means approvals are dry runs), `WEEKLY_DRAFT_AT` (e.g. `fri 10:00`) with `WEEKLY_DRAFT_TZ`, and the models: `DRAFT_MODEL` (default `claude-opus-5-5`) writes drafts, `CHAT_MODEL` (`claude-sonnet-5-5`) discusses and revises them, and `REFERENCE_MODEL` (`claude-haiku-5-5`) answers brand and asset questions like "white logo as SVG". The routing is a small word check in `modelFor()` (`src/run-agent.ts`); each run's model is in `data/runs.jsonl`. See `config.example.env` for the full list.

## How it stays safe

| Risk | Control | Where |
|---|---|---|
| A compromised agent run | Each turn gets a fresh sandbox with no public egress, as a non-root user, holding only a short-lived session token. The host re-checks every draft it returns and only the host writes the store. | `src/sandbox/` |
| Credential leaks | The proxy injects credentials on the wire, and the sandbox only holds placeholders. Answers and drafts are also scanned for token patterns and placeholders. | `src/sandbox/job.ts`, `src/secret-guard.ts` |
| Posting something nobody approved | The agent has no Slack-write tool. Only `approveDraft()` on the host posts, and it runs on a human click. | `src/drafts/actions.ts`, `src/slack-approval.ts` |
| Invented sources | Each draft line must cite `source_id`s a tool returned during that run, checked in the sandbox and again on the host. | `src/drafts/validate.ts`, `src/sandbox/accept.ts` |
| Reading beyond scope | Each client enforces its own allowlist (see Scope). | `src/*/client.ts`, `src/external-mcp.ts` |
| Prompt injection in Slack/Linear/PRs | Third-party text is fenced as `<untrusted_content>`; the system prompt treats it as evidence, never instructions. Worst case is a bad line in a pending draft, with its sources visible. | `src/tool-result.ts`, `src/prompt.ts` |
| Unauthorized people | Slack users must be on `DESIGN_ALLOWLIST` (fails closed). The inbox needs `WEB_ACCESS_PASSWORD`. | `src/access.ts`, `src/web/server.ts` |
| Generated code | `tools: []` disables every built-in tool, so only the MCP tools exist. | `src/run-agent.ts` |

Every run is appended to `data/runs.jsonl` with its tool calls and source count, and every draft keeps a history of who created, edited, approved, or rejected it.

## Adding a source without touching the core

Figma is connected through Framelink's `figma-developer-mcp`, a third-party MCP server, declared in `mcp-servers.json`:

```json
"figma": {
  "command": "node", "args": ["node_modules/figma-developer-mcp/dist/bin.js", "--stdio"],
  "env": { "FIGMA_API_KEY": "${FIGMA_API_KEY}" },
  "allowedTools": ["get_figma_data"],
  "scope": { "argument": "fileKey", "allowEnv": "FIGMA_FILE_KEYS" },
  "source": { "kind": "figma", "idArgument": "fileKey", "url": "https://www.figma.com/design/{id}" }
}
```

The core mounts the server and allows only `allowedTools`. A `PreToolUse` hook denies any call whose `fileKey` isn't authorized: a single file in `FIGMA_FILE_KEYS`, or any file inside a Figma project (folder) in `FIGMA_PROJECT_IDS`, resolved at run time through the declared `expand` resolver. Nothing authorized means everything is denied. The Figma PAT needs `projects:read` for project listing. A small native `list_figma_files` tool shows the agent which authorized files changed this week. A `PostToolUse` hook registers each successful call as a citable source. To add another server, add an entry to `mcp-servers.json`; no code changes.

## Eval

`make eval RUNS=3` drafts against a fictional week in `fixtures/` and scores it against hand-traced ground truth (`fixtures/expected.json`): coverage, status accuracy, citations, injection handling, and scope. It runs in the same sandbox as real runs, with its own throwaway data directory, so its drafts never reach the inbox. The fixtures exist only for the eval and tests; the app has no demo mode.

## Known limitations

- Modal sidecars are a beta feature (`experimentalSidecars`). DNS stays open inside the sandbox, a possible low-bandwidth exfiltration channel. Each sidecar holds the proxy token, which works until it's rotated in Infisical. These come from modal-agent's design.
- Figma coverage is file structure only (name, pages, frames). Framelink doesn't expose comments or version history.
- Drafts are JSON files, fine for one instance. Multiple replicas would need a database.
- Inbox auth is a shared password plus a self-reported name, not SSO.
- The weekly window is a rolling 7 days, not calendar weeks.
