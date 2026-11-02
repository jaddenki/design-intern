// Third-party MCP servers declared in mcp-servers.json. Adding one is a config change,
// not a code change: the core mounts it, allows only its listed tools, and enforces its
// declared argument allowlist and source tracking through SDK hooks, so a server we
// didn't write still can't leave its scope or feed uncitable content into a draft.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HookCallbackMatcher, HookEvent, McpHttpServerConfig, McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { APP_ROOT, envList } from "./config.js";
import { authorizedFileKeys } from "./figma/projects.js";
import { recordSource, type Access, type RunContext, type RunMode, type SourceKind } from "./run-context.js";

interface Scope {
  argument: string;
  allowEnv: string;
  expand?: keyof typeof SCOPE_RESOLVERS;
}

export interface ExternalServerSpec {
  description: string;
  /** "stdio" (default) runs `command`; "http" connects to `url` through the proxy. */
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  requiredEnv?: string[];
  /** Tools callable in any run. Everything else the server exposes is denied. */
  allowedTools: string[];
  /** Tools callable only in a write run (write Agent Vault bundle). */
  writeTools?: string[];
  /** "write": mount the server only in write runs. */
  access?: Access;
  /** Run modes that mount the server; default all. */
  modes?: RunMode[];
  /**
   * Calls must pass `argument` with a value listed in env `allowEnv`, or returned by the
   * named `expand` resolver. Empty list = deny all.
   */
  scope?: Scope;
  /** Replaces `scope` for writeTools, so writes can be narrower than reads. */
  writeScope?: Scope;
  /** Listed tools that take no scoped argument (e.g. reading the server's own docs). */
  unscopedTools?: string[];
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

/** `${VAR}` or `${VAR:-fallback}` from the environment. */
const expand = (value: string) =>
  value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, key: string, fallback?: string) => process.env[key]?.trim() || fallback || "");

export interface RunScope {
  access: Access;
  mode: RunMode;
}

const ALL: RunScope = { access: "write", mode: "chat" };

function mountedIn(spec: ExternalServerSpec, run: RunScope): boolean {
  if (spec.access === "write" && run.access !== "write") return false;
  return !spec.modes || spec.modes.includes(run.mode);
}

/** Specs whose required env is present and that this run mounts, as SDK configs. */
export function activeServers(specs = loadSpecs(), run: RunScope = ALL): Record<string, McpStdioServerConfig | McpHttpServerConfig> {
  const out: Record<string, McpStdioServerConfig | McpHttpServerConfig> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const missing = (spec.requiredEnv ?? []).filter((k) => !process.env[k]?.trim());
    if (missing.length > 0 || !mountedIn(spec, run)) continue;
    const env = Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, expand(v)]));
    if (spec.type === "http") {
      if (!spec.url) continue;
      out[name] = { type: "http", url: expand(spec.url), headers: Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k, expand(v)])) };
    } else {
      if (!spec.command) continue;
      out[name] = { type: "stdio", command: spec.command, args: spec.args, env };
    }
  }
  return out;
}

/** Bare tool names this run may call on a server. */
export function toolsFor(spec: ExternalServerSpec, access: Access): string[] {
  return access === "write" ? [...spec.allowedTools, ...(spec.writeTools ?? [])] : spec.allowedTools;
}

export function allowedToolNames(name: string, spec: ExternalServerSpec, access: Access = "read"): string[] {
  return toolsFor(spec, access).map((t) => `mcp__${name}__${t}`);
}

/** Pure: decide whether a call stays inside the server's declared scope. */
export function checkScope(spec: ExternalServerSpec, input: unknown, expanded: string[] = [], scope = spec.scope): { ok: true } | { ok: false; reason: string } {
  if (!scope) return { ok: true };
  const allowed = [...envList(scope.allowEnv), ...expanded];
  const value = (input as Record<string, unknown> | undefined)?.[scope.argument];
  if (allowed.length === 0) {
    return { ok: false, reason: `No ${scope.argument} values are authorized (${scope.allowEnv} is empty and nothing else is authorized).` };
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    return { ok: false, reason: `${scope.argument} "${String(value)}" is not on the authorized list for this tool.` };
  }
  return { ok: true };
}

/** Pure: the tool must be listed for this run's access, and its scope must hold. */
export function checkCall(
  spec: ExternalServerSpec,
  tool: string,
  access: Access,
): { ok: false; reason: string } | { ok: true; scope?: Scope } {
  const isWrite = spec.writeTools?.includes(tool) ?? false;
  if (!spec.allowedTools.includes(tool) && !isWrite) return { ok: false, reason: `${tool} isn't an allowed tool.` };
  if (isWrite && access !== "write") return { ok: false, reason: `${tool} changes things and needs a write session; call request_write_access first.` };
  if (spec.unscopedTools?.includes(tool)) return { ok: true };
  return { ok: true, scope: isWrite ? (spec.writeScope ?? spec.scope) : spec.scope };
}

function parseToolName(specs: Record<string, ExternalServerSpec>, toolName: string): { spec: ExternalServerSpec; tool: string } | undefined {
  const [, server, tool] = toolName.match(/^mcp__([a-z0-9_]+)__(.+)$/) ?? [];
  return server && specs[server] ? { spec: specs[server], tool } : undefined;
}

function responseIsError(response: unknown): boolean {
  return Boolean((response as { isError?: boolean } | undefined)?.isError);
}

const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
});

/** Hooks enforcing tool lists, scope, and source tracking for every declared server, plus the run log. */
export function buildHooks(ctx: RunContext, specs = loadSpecs()): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            ctx.toolCalls.push({ name: input.tool_name, input: input.tool_input, at: new Date().toISOString() });
            const parsed = parseToolName(specs, input.tool_name);
            if (!parsed) return {};
            // bypassPermissions ignores allowedTools, so the tool list is enforced here.
            const call = checkCall(parsed.spec, parsed.tool, ctx.access);
            if (!call.ok) return deny(call.reason);
            const resolver = call.scope?.expand ? SCOPE_RESOLVERS[call.scope.expand] : undefined;
            const expanded = resolver ? await resolver().catch(() => []) : [];
            const verdict = checkScope(parsed.spec, input.tool_input, expanded, call.scope);
            return verdict.ok ? {} : deny(verdict.reason);
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PostToolUse") return {};
            const spec = parseToolName(specs, input.tool_name)?.spec;
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

function describeScope(scope: Scope | undefined): string {
  if (!scope) return "";
  const listed = envList(scope.allowEnv).join(", ") || "none listed";
  const more = scope.expand === "figma-projects" ? " plus every file in the authorized Figma projects (call list_figma_files to see them)" : "";
  return `${scope.argument}: ${listed}${more}`;
}

export function describeServers(specs = loadSpecs(), run: RunScope = ALL, active = activeServers(specs, run)): string[] {
  return Object.keys(active).map((name) => {
    const spec = specs[name];
    const tools = allowedToolNames(name, spec, run.access).join(", ");
    const scope = spec.scope ? ` Authorized ${describeScope(spec.scope)}.` : "";
    const writes = run.access === "write" && spec.writeTools?.length && spec.writeScope ? ` Writes are limited to ${describeScope(spec.writeScope)}.` : "";
    const cite = spec.source ? ` Cite as ${spec.source.kind}:<${spec.source.idArgument}>.` : "";
    return `- ${name} (${tools}): ${spec.description}${scope}${writes}${cite}`;
  });
}
