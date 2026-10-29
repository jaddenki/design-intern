import assert from "node:assert/strict";
import { test } from "node:test";
import { activeServers, buildHooks, checkScope, loadSpecs, type ExternalServerSpec } from "./external-mcp.js";
import { createRunContext } from "./run-context.js";

const spec: ExternalServerSpec = {
  description: "test",
  command: "node",
  args: ["server.js"],
  env: { KEY: "${TEST_FIGMA_KEY}" },
  requiredEnv: ["TEST_FIGMA_KEY"],
  allowedTools: ["get_figma_data"],
  scope: { argument: "fileKey", allowEnv: "TEST_FIGMA_FILES" },
  source: { kind: "figma", idArgument: "fileKey", url: "https://www.figma.com/design/{id}" },
};

test("scope: denies everything when the allowlist is empty", () => {
  delete process.env.TEST_FIGMA_FILES;
  assert.equal(checkScope(spec, { fileKey: "abc" }).ok, false);
});

test("scope: allows listed values only", () => {
  process.env.TEST_FIGMA_FILES = "abc, def";
  assert.equal(checkScope(spec, { fileKey: "def" }).ok, true);
  assert.equal(checkScope(spec, { fileKey: "zzz" }).ok, false);
  assert.equal(checkScope(spec, {}).ok, false);
});

test("servers missing required env aren't mounted; env is expanded", () => {
  delete process.env.TEST_FIGMA_KEY;
  assert.deepEqual(activeServers({ figma: spec }), {});
  process.env.TEST_FIGMA_KEY = "__figma_api_key__";
  assert.equal(activeServers({ figma: spec }).figma?.env?.KEY, "__figma_api_key__");
});

test("hooks deny out-of-scope calls and record in-scope sources", async () => {
  process.env.TEST_FIGMA_FILES = "abc";
  const ctx = createRunContext({ mode: "draft", actor: "test" });
  const hooks = buildHooks(ctx, { figma: spec });
  const pre = hooks.PreToolUse![0].hooks[0];
  const post = hooks.PostToolUse![0].hooks[0];
  const base = { session_id: "s", transcript_path: "", cwd: "", tool_use_id: "t" };
  const signal = new AbortController().signal;

  const denied = await pre({ ...base, hook_event_name: "PreToolUse", tool_name: "mcp__figma__get_figma_data", tool_input: { fileKey: "nope" } }, "t", { signal });
  assert.equal((denied as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, "deny");

  await post({ ...base, hook_event_name: "PostToolUse", tool_name: "mcp__figma__get_figma_data", tool_input: { fileKey: "abc" }, tool_response: {} }, "t", { signal });
  assert.equal(ctx.sources.get("figma:abc")?.url, "https://www.figma.com/design/abc");

  await post({ ...base, hook_event_name: "PostToolUse", tool_name: "mcp__figma__get_figma_data", tool_input: { fileKey: "err" }, tool_response: { isError: true } }, "t", { signal });
  assert.ok(!ctx.sources.has("figma:err"));
  assert.equal(ctx.toolCalls.length, 1);
});

test("shipped mcp-servers.json declares Figma with a scope", () => {
  const figma = loadSpecs().figma;
  assert.ok(figma);
  assert.deepEqual(figma.allowedTools, ["get_figma_data"]);
  assert.equal(figma.scope?.allowEnv, "FIGMA_FILE_KEYS");
});

test("scope: resolver-expanded values are authorized too", () => {
  process.env.TEST_FIGMA_FILES = "abc";
  assert.equal(checkScope(spec, { fileKey: "fromProject" }).ok, false);
  assert.equal(checkScope(spec, { fileKey: "fromProject" }, ["fromProject"]).ok, true);
  delete process.env.TEST_FIGMA_FILES;
  assert.equal(checkScope(spec, { fileKey: "fromProject" }, ["fromProject"]).ok, true);
  assert.equal(checkScope(spec, { fileKey: "abc" }, ["fromProject"]).ok, false);
});
