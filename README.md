# agent-template

A starter kit for building an internal AI agent (either a Slack bot or a command-line tool) that can connect to external services like Linear, GitHub, or anything else with an API.

You don't need to read or write the code yourself. Fork this repo, open it in Claude Code (or Cursor), and describe what you want the agent to do. The repo includes a `CLAUDE.md` that explains its structure to the AI, so the AI knows exactly which files to edit.

## Run it locally

```bash
git clone <your-fork-url>
cd agent-template
npm install
cp .env.example .env
```

Open `.env` and fill in:

- `ANTHROPIC_API_KEY`: get one from [console.anthropic.com](https://console.anthropic.com)
- `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`: only needed if you want a Slack bot. Follow Slack's [Bolt for JavaScript quickstart](https://tools.slack.dev/bolt-js/getting-started/) to create the app and grab both tokens, or just ask Claude Code to walk you through the Slack dashboard step by step.

Try it from the terminal:

```bash
npm start "Hello, what can you do?"
```

Or run it as a Slack bot:

```bash
npm run start:slack
```

## Make it your own

Open the repo in Claude Code (or Cursor) and tell it what you want. For example:

- "Turn this into a bot that answers questions about our Linear issues."
- "Add a tool that reads our GitHub PRs and summarizes them in Slack."
- "Change the bot's name and greeting message."

You describe the goal, and the AI does the editing.

## Deploy to Render

We host these agents on the team's Render account.

1. In Render, create a new **Web Service**, point it at your fork, and choose **Docker** as the runtime.
2. Set the health check path to `/health`.
3. Set these environment variables on the service:

   ```
   ANTHROPIC_API_KEY=__anthropic_api_key__
   AGENT_VAULT_ADDR=http://<your-addr>:14321
   AGENT_VAULT_TOKEN=<agent-token-from-agent-vault>
   AGENT_VAULT_VAULT=<vault-in-agent-vault>
   ```

   If your agent runs as a Slack bot, also add `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` using the placeholder pattern explained below.

### About those placeholders

`__anthropic_api_key__` looks odd because it's not the real key. It's a placeholder. Agent Vault swaps placeholders for the real credentials at request time, so the real keys never live in Render.

**Whenever you add a new integration that needs an API key, follow this pattern:**

1. Store the real credential in Agent Vault (ask whoever owns it to add it for you).
2. In Render, set the env var to a placeholder like `__service_name_api_key__` instead of the real value.

That way credentials stay in one place (Agent Vault), and the Render config is safe to share.

## A real example to learn from

[`talent-agent`](https://github.com/infisical/talent-agent) is a working agent built from this template that integrates with the Ashby recruiting API. Point Claude Code at it when you ask for a new integration: "build this kind of integration, like the one in talent-agent."
