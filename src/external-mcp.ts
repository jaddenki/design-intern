// Third-party MCP servers declared in mcp-servers.json. Adding one is a config change,
// not a code change: the core mounts it, allows only its listed tools, and enforces its
// declared argument allowlist and source tracking through SDK hooks, so a server we
// didn't write still can't leave its scope or feed uncitable content into a draft.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HookCallbackMatcher, HookEvent, McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { APP_ROOT, envList } from "./config.js";
import { authorizedFileKeys } from "./figma/projects.js";
import { recordSource, type RunContext, type SourceKind } from "./run-context.js";

export interface ExternalServerSpec {
  description: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  requiredEnv?: string[];
  allowedTools: string[];
  /**
   * Calls must pass `argument` with a value listed in env `allowEnv`, or returned by the
   * named `expand` resolver. Empty list = deny all.
   */
  scope?: { argument: string; allowEnv: string; expand?: keyof typeof SCOPE_RESOLVERS };
  /** Register successful calls as citable sources. `{id}` in url is replaced. */
  source?: { kind: SourceKind; idArgument: string; url?: string };
}

/** Named resolvers a config entry can use to widen its allowlist at run time. */
export const SCOPE_RESOLVERS = {
  "figma-projects": authorizedFileKeys,
} satisfies Record<string, () => Promise<string[]>>;

const CONFIG_PATH = path.join(APP_ROOT, "mcp-servers.json");
const NAME = /^[a-z][a-z0-9_]*$/;

export function loadSpecs(file = CONFIG_PATH): Record<string, ExternalServerSpec> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, ExternalServerSpec>;
    return Object.fromEntries(Object.entries(raw).filter(([name]) => NAME.test(name)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

const expand = (value: string) => value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => process.env[key] ?? "");

/** Specs whose required env is present, as SDK stdio configs. */
export function activeServers(specs = loadSpecs()): Record<string, McpStdioServerConfig> {
  const out: Record<string, McpStdioServerConfig> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const missing = (spec.requiredEnv ?? []).filter((k) => !process.env[k]);
    if (missing.length > 0) continue;
    out[name] = {
      type: "stdio",
      command: spec.command,
      args: spec.args,
      env: Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, expand(v)])),
    };
  }
  return out;
}

export function allowedToolNames(name: string, spec: ExternalServerSpec): string[] {
  return spec.allowedTools.map((t) => `mcp__${name}__${t}`);
}

/** Pure: decide whether a call stays inside the server's declared scope. */
export function checkScope(spec: ExternalServerSpec, input: unknown, expanded: string[] = []): { ok: true } | { ok: false; reason: string } {
  if (!spec.scope) return { ok: true };
  const allowed = [...envList(spec.scope.allowEnv), ...expanded];
  const value = (input as Record<string, unknown> | undefined)?.[spec.scope.argument];
  if (allowed.length === 0) {
    return { ok: false, reason: `No ${spec.scope.argument} values are authorized (${spec.scope.allowEnv} is empty and nothing else is authorized).` };
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    return { ok: false, reason: `${spec.scope.argument} "${String(value)}" is not on the authorized list; only authorized files can be read.` };
  }
  return { ok: true };
}

function specForTool(specs: Record<string, ExternalServerSpec>, toolName: string): ExternalServerSpec | undefined {
  const [, server] = toolName.match(/^mcp__([a-z0-9_]+)__/) ?? [];
  return server ? specs[server] : undefined;
}

function responseIsError(response: unknown): boolean {
  return Boolean((response as { isError?: boolean } | undefined)?.isError);
}

/** Hooks enforcing scope and source tracking for every declared server, plus the run log. */
export function buildHooks(ctx: RunContext, specs = loadSpecs()): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            ctx.toolCalls.push({ name: input.tool_name, input: input.tool_input, at: new Date().toISOString() });
            const spec = specForTool(specs, input.tool_name);
            const expand = spec?.scope?.expand ? SCOPE_RESOLVERS[spec.scope.expand] : undefined;
            const expanded = expand ? await expand().catch(() => []) : [];
            const verdict = spec ? checkScope(spec, input.tool_input, expanded) : { ok: true as const };
            if (verdict.ok) return {};
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: verdict.reason,
              },
            };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PostToolUse") return {};
            const spec = specForTool(specs, input.tool_name);
            if (!spec?.source || responseIsError(input.tool_response)) return {};
            const id = (input.tool_input as Record<string, unknown>)?.[spec.source.idArgument];
            if (typeof id !== "string" || !id) return {};
            recordSource(ctx, {
              id: `${spec.source.kind}:${id}`,
              kind: spec.source.kind,
              title: `${spec.source.kind === "figma" ? "Figma file" : spec.source.kind} ${id}`,
              url: spec.source.url?.replace("{id}", encodeURIComponent(id)),
            });
            return {};
          },
        ],
      },
    ],
  };
}

export function describeServers(specs = loadSpecs(), active = activeServers(specs)): string[] {
  return Object.keys(active).map((name) => {
    const spec = specs[name];
    const listed = spec.scope ? envList(spec.scope.allowEnv).join(", ") || "none listed" : "";
    const more = spec.scope?.expand === "figma-projects" ? " plus every file in the authorized Figma projects (call list_figma_files to see them)" : "";
    const scope = spec.scope ? ` Authorized ${spec.scope.argument} values: ${listed}${more}.` : "";
    const cite = spec.source ? ` Cite as ${spec.source.kind}:<${spec.source.idArgument}>.` : "";
    return `- ${name} (${spec.allowedTools.map((t) => `mcp__${name}__${t}`).join(", ")}): ${spec.description}${scope}${cite}`;
  });
}
