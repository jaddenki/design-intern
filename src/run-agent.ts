import { query } from "@anthropic-ai/claude-agent-sdk";
import { agentServer, SERVER_NAME } from "./agent.js";

// TODO: customize per-tool progress labels by switching on `toolName`.
// Example:
//   case "mcp__agent__echo": return ":speech_balloon: Echoing…";
function toolProgressLabel(_toolName: string, _input: Record<string, unknown>): string | null {
  return ":hourglass_flowing_sand: Working…";
}

export async function runAgent(
  prompt: string,
  onProgress?: (message: string) => void,
): Promise<string> {
  let result = "";

  for await (const event of query({
    prompt,
    options: {
      model: "claude-sonnet-4-6",
      // Workaround for anthropics/claude-agent-sdk-typescript#296. Set in Dockerfile.
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
      // TODO: replace with your agent's persona and instructions.
      systemPrompt:
        "You are a helpful AI assistant. You may be given a Slack thread transcript as context — use it to understand the conversation, then respond to the latest message. Be concise and friendly. Format responses for Slack (use *bold*, _italic_, bullet points with •).",
      mcpServers: { [SERVER_NAME]: agentServer },
      allowedTools: [`mcp__${SERVER_NAME}__*`],
      tools: [],
      permissionMode: "bypassPermissions",
      persistSession: false,
    },
  })) {
    if (event.type === "assistant" && onProgress) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          const label = toolProgressLabel(block.name, block.input as Record<string, unknown>);
          if (label) onProgress(label);
        }
      }
    }

    if (event.type === "result" && event.subtype === "success") {
      result = event.result;
    }
  }

  return result;
}
