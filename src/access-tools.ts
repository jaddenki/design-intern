// Read sessions can't change anything. When a chat needs to
// draft a Contentful entry, the agent asks here and stops; the host decides whether to
// rerun the request in a session over the write bundle (run-agent.ts).
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { RunContext } from "./run-context.js";
import { text } from "./tool-result.js";

/** The host sets WRITE_ACCESS_AVAILABLE for the sandbox; locally the bundle name is enough. */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AGENT_VAULT_WRITE_BUNDLE?.trim()) || env.WRITE_ACCESS_AVAILABLE === "1";
}

export function accessTools(ctx: RunContext) {
  return [
    tool(
      "request_write_access",
      "Ask for a write session when the person explicitly asked you to change something you can only change with write tools: create or update a draft entry or asset in Contentful. This session ends after the call and the request reruns with write tools. Don't call it for questions, drafting the weekly update, or anything a read can answer.",
      { reason: z.string().min(5).max(200).describe("What you'll change and where, e.g. 'Draft a Contentful case study entry for Acme'.") },
      async (args) => {
        ctx.writeRequest = { reason: args.reason.trim() };
        return text("Write access requested. Stop now: reply with one short sentence saying you're starting a write session. Don't attempt the change in this session.");
      },
    ),
  ];
}
