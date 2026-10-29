// The contract between the host and the sandbox: one job in on stdin, NDJSON
// events out on stdout. Nothing secret crosses it in either direction.
import type { Draft } from "../drafts/types.js";
import type { RunMode, SourceRef } from "../run-context.js";

export interface Job {
  prompt: string;
  mode: RunMode;
  actor: string;
  runId: string;
  model: string;
  draft?: Draft;
  /** Sources citable from the start: the draft's, plus a check-in. */
  seed: SourceRef[];
  env: Record<string, string>;
}

export type SandboxEvent =
  | { type: "progress"; label: string }
  | {
      type: "result";
      text: string;
      sources: SourceRef[];
      toolCalls: { name: string; input: unknown; at: string }[];
      drafts: Draft[];
    }
  | { type: "error"; message: string };

/** Scope config the agent's tools read. Values pass through as-is. */
const FORWARDED = [
  "AGENT_NAME",
  "DATA_SOURCE",
  "DRAFT_MODEL",
  "CHAT_MODEL",
  "LINEAR_TEAM_KEYS",
  "LINEAR_ASSIGNEE_EMAILS",
  "GITHUB_REPOS",
  "DESIGN_GITHUB_LOGINS",
  "DESIGN_SLACK_CHANNELS",
  "FIGMA_PROJECT_IDS",
  "FIGMA_FILE_KEYS",
];

/**
 * Credentials the sandbox gets as placeholders only; the sidecar proxy swaps in the
 * real value. The host's own value (a real Slack token, say) is never forwarded.
 */
export const PLACEHOLDERS: Record<string, string> = {
  ANTHROPIC_API_KEY: "__anthropic_api_key__",
  LINEAR_API_KEY: "__linear_api_key__",
  GITHUB_TOKEN: "__github_token__",
  FIGMA_API_KEY: "__figma_api_key__",
  SLACK_BOT_TOKEN: "__slack_bot_token__",
};

export function sandboxEnv(host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { ANTHROPIC_API_KEY: PLACEHOLDERS.ANTHROPIC_API_KEY };
  for (const key of FORWARDED) if (host[key]?.trim()) env[key] = host[key]!.trim();
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) if (host[key]?.trim()) env[key] = placeholder;
  return env;
}

export const EVENT_PREFIX = "@@design-intern ";

export function encodeEvent(event: SandboxEvent): string {
  return `${EVENT_PREFIX}${JSON.stringify(event)}\n`;
}

/** Events for one stdout line; anything without the prefix is log noise. */
export function parseEventLine(line: string): SandboxEvent | undefined {
  if (!line.startsWith(EVENT_PREFIX)) return undefined;
  try {
    const event = JSON.parse(line.slice(EVENT_PREFIX.length)) as SandboxEvent;
    return typeof event?.type === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}
