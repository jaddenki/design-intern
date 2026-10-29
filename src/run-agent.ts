import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildServers } from "./agent.js";
import { AGENT_RUNNER, CHAT_MODEL, DRAFT_MODEL } from "./config.js";
import { appendRunLog, getDraft } from "./drafts/store.js";
import type { Draft } from "./drafts/types.js";
import { buildHooks } from "./external-mcp.js";
import { systemPrompt } from "./prompt.js";
import { createRunContext, type RunContext, type RunMode } from "./run-context.js";
import { containsSecret } from "./secret-guard.js";

export function toolProgressLabel(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case "mcp__linear__list_design_issues":
      return ":clipboard: Reading design issues in Linear…";
    case "mcp__github__list_design_prs":
      return ":twisted_rightwards_arrows: Checking design PRs…";
    case "mcp__slack__read_design_channels":
      return ":speech_balloon: Reading design channels…";
    case "mcp__figma_index__list_figma_files":
      return ":art: Listing design files in Figma…";
    case "mcp__figma__get_figma_data":
      return `:art: Opening Figma file ${String(input.fileKey ?? "")}…`;
    case "mcp__knowledge__search_design_knowledge":
      return `:books: Searching design docs for "${String(input.query ?? "")}"…`;
    case "mcp__knowledge__read_design_doc":
      return ":books: Reading a design doc…";
    case "mcp__drafts__submit_draft":
      return ":memo: Saving the draft for approval…";
    case "mcp__drafts__revise_draft":
      return ":memo: Revising the draft…";
    default:
      return ":hourglass_flowing_sand: Working…";
  }
}

export interface RunAgentOptions {
  mode?: RunMode;
  /** Who asked, for the run log and draft history, e.g. "slack:maya@x.com". */
  actor?: string;
  /** Draft this conversation is about; its sources become citable. */
  draftId?: string;
  onProgress?: (message: string) => void;
}

export interface AgentResult {
  text: string;
  ctx: RunContext;
}

export const modelFor = (mode: RunMode) => (mode === "draft" ? DRAFT_MODEL : CHAT_MODEL);

/** The agent loop itself. Runs on the host locally, or inside the sandbox (sandbox/entry.ts). */
export async function runInProcess(
  prompt: string,
  ctx: RunContext,
  draft: Draft | undefined,
  onProgress?: (message: string) => void,
): Promise<string> {
  const { mcpServers, allowedTools } = buildServers(ctx);
  let result = "";
  for await (const event of query({
    prompt,
    options: {
      model: modelFor(ctx.mode),
      // Workaround for anthropics/claude-agent-sdk-typescript#296. Set in Dockerfile.
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
      systemPrompt: systemPrompt(ctx.mode, draft),
      mcpServers,
      allowedTools,
      hooks: buildHooks(ctx),
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
    if (event.type === "result" && event.subtype === "success") result = event.result;
  }
  return result;
}

export async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<AgentResult> {
  const { mode = "chat", actor = "cli", draftId, onProgress } = options;
  const draft = draftId ? getDraft(draftId) : undefined;
  const ctx = createRunContext({ mode, actor, draftId: draft?.id, seed: draft ? Object.values(draft.sources) : [] });
  const startedAt = new Date().toISOString();
  let error: string | undefined;

  try {
    let result: string;
    if (AGENT_RUNNER === "modal") {
      const { runInSandbox } = await import("./sandbox/runner.js");
      result = await runInSandbox(prompt, ctx, draft, onProgress);
    } else {
      result = await runInProcess(prompt, ctx, draft, onProgress);
    }
    // The agent holds no credentials, so this should never fire; refuse rather than relay.
    if (containsSecret(result)) {
      throw new Error("Response contained a credential-like string; refusing to relay it.");
    }
    return { text: result, ctx };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    appendRunLog({
      runId: ctx.runId,
      mode,
      actor,
      startedAt,
      finishedAt: new Date().toISOString(),
      model: modelFor(mode),
      toolCalls: ctx.toolCalls,
      sourcesSeen: ctx.sources.size,
      draftId: ctx.savedDraftId ?? ctx.draftId,
      error,
    });
  }
}
