import { createSdkMcpServer, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { USE_FIXTURES } from "./config.js";
import { draftTools } from "./drafts/tools/index.js";
import { activeServers, allowedToolNames, loadSpecs } from "./external-mcp.js";
import { figmaFixtureTools } from "./figma/fixture-server.js";
import { figmaIndexTools } from "./figma/tools.js";
import { githubTools } from "./github/tools/index.js";
import { knowledgeTools } from "./knowledge/tools/index.js";
import { linearTools } from "./linear/tools/index.js";
import type { RunContext } from "./run-context.js";
import { slackSourceTools } from "./slack-source/tools/index.js";

type SdkTools = Parameters<typeof createSdkMcpServer>[0]["tools"];

// alwaysLoad keeps every tool schema in the turn-1 prompt instead of behind tool
// search, so the model calls tools rather than narrating calls as text.
function server(name: string, tools: SdkTools) {
  return createSdkMcpServer({ name, version: "1.0.0", tools, alwaysLoad: true });
}

/**
 * Servers are built per run so each run's tools share one RunContext. allowedTools is
 * derived from what's mounted, so the mount list and allowlist can't drift apart.
 */
export function buildServers(ctx: RunContext): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } {
  const mcpServers: Record<string, McpServerConfig> = {
    linear: server("linear", linearTools(ctx)),
    github: server("github", githubTools(ctx)),
    slack: server("slack", slackSourceTools(ctx)),
    knowledge: server("knowledge", knowledgeTools(ctx)),
    drafts: server("drafts", draftTools(ctx)),
  };
  const allowedTools = Object.keys(mcpServers).map((name) => `mcp__${name}__*`);

  const specs = loadSpecs();
  if (specs.figma) {
    mcpServers.figma_index = server("figma_index", figmaIndexTools(ctx));
    allowedTools.push("mcp__figma_index__*");
  }
  if (USE_FIXTURES) {
    if (specs.figma) {
      mcpServers.figma = server("figma", figmaFixtureTools());
      allowedTools.push(...allowedToolNames("figma", specs.figma));
    }
  } else {
    for (const [name, config] of Object.entries(activeServers(specs))) {
      mcpServers[name] = { ...config, alwaysLoad: true };
      allowedTools.push(...allowedToolNames(name, specs[name]));
    }
  }
  return { mcpServers, allowedTools };
}
