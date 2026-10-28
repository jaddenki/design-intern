import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { echo } from "./tools/echo.js";

// TODO: rename to your service name. Tools are exposed to the agent as
// mcp__<SERVER_NAME>__<tool-name>. run-agent.ts derives mcpServers + allowedTools
// from this constant, so changing it here propagates everywhere.
export const SERVER_NAME = "agent";

export const agentServer = createSdkMcpServer({
  name: SERVER_NAME,
  version: "1.0.0",
  tools: [echo],
});
