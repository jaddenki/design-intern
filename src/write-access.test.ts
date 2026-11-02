import assert from "node:assert/strict";
import { test } from "node:test";
import { accessTools, writesEnabled } from "./access-tools.js";
import { buildHooks, checkCall, loadSpecs, type ExternalServerSpec } from "./external-mcp.js";
import { createRunContext } from "./run-context.js";
import { acceptResult } from "./sandbox/accept.js";
import { sandboxEnv } from "./sandbox/job.js";
import { describeRun } from "./sandbox/vault.js";

const spec: ExternalServerSpec = {
  description: "cms",
  command: "node",
  allowedTools: ["get_entry"],
  writeTools: ["create_entry"],
  scope: { argument: "spaceId", allowEnv: "TEST_SPACE" },
};

const base = { session_id: "s", transcript_path: "", cwd: "", tool_use_id: "t" };
const signal = new AbortController().signal;
const decision = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

test("write tools: denied in read sessions, unlisted tools denied always", () => {
  assert.equal(checkCall(spec, "get_entry", "read").ok, true);
  assert.equal(checkCall(spec, "create_entry", "read").ok, false);
  assert.equal(checkCall(spec, "create_entry", "write").ok, true);
  assert.equal(checkCall(spec, "publish_entry", "write").ok, false);
});

test("hooks enforce the tool list even though bypassPermissions ignores allowedTools", async () => {
  process.env.TEST_SPACE = "sp1";
  const read = buildHooks(createRunContext({ mode: "chat", actor: "t" }), { cms: spec }).PreToolUse![0].hooks[0];
  const write = buildHooks(createRunContext({ mode: "chat", access: "write", actor: "t" }), { cms: spec }).PreToolUse![0].hooks[0];
  const call = (tool: string, input: object) => ({ ...base, hook_event_name: "PreToolUse" as const, tool_name: `mcp__cms__${tool}`, tool_input: input });
  assert.equal(decision(await read(call("create_entry", { spaceId: "sp1" }), "t", { signal })), "deny");
  assert.equal(decision(await read(call("delete_entry", { spaceId: "sp1" }), "t", { signal })), "deny");
  assert.equal(decision(await write(call("create_entry", { spaceId: "sp1" }), "t", { signal })), undefined);
  assert.equal(decision(await write(call("create_entry", { spaceId: "other" }), "t", { signal })), "deny");
  assert.equal(decision(await write(call("publish_entry", { spaceId: "sp1" }), "t", { signal })), "deny");
});

test("shipped config: Contentful never publishes or deletes; nothing writes to Figma", () => {
  const specs = loadSpecs();
  const cms = specs.contentful;
  const every = [...cms.allowedTools, ...(cms.writeTools ?? [])];
  assert.ok(every.every((t) => !/publish|delete|unpublish|environment|locale_|space_to/.test(t)));
  assert.equal(specs.figma.writeTools, undefined);
  assert.equal(specs.figma.type, undefined);
  assert.equal(cms.type, "http");
  assert.ok(!JSON.stringify(cms).includes("Authorization"));
});

test("request_write_access records the reason; only offered when a write bundle exists", async () => {
  assert.equal(writesEnabled({}), false);
  assert.equal(writesEnabled({ AGENT_VAULT_WRITE_BUNDLE: "design-intern-write" }), true);
  assert.equal(writesEnabled({ WRITE_ACCESS_AVAILABLE: "1" }), true);
  const ctx = createRunContext({ mode: "chat", actor: "t" });
  const [tool] = accessTools(ctx);
  await tool.handler({ reason: "Draft the Acme case study entry" }, {});
  assert.equal(ctx.writeRequest?.reason, "Draft the Acme case study entry");
});

test("sandbox env: says writes exist without forwarding the bundle name", () => {
  const env = sandboxEnv({ AGENT_VAULT_WRITE_BUNDLE: "design-intern-write", CONTENTFUL_SPACE_ID: "sp1" });
  assert.equal(env.WRITE_ACCESS_AVAILABLE, "1");
  assert.equal(env.AGENT_VAULT_WRITE_BUNDLE, undefined);
  assert.equal(env.CONTENTFUL_SPACE_ID, "sp1");
});

test("host accepts a write request only from a read chat", () => {
  const result = { type: "result" as const, text: "", sources: [], toolCalls: [], drafts: [], writeRequest: { reason: "  Edit\nthe file " } };
  const chat = createRunContext({ mode: "chat", actor: "t" });
  acceptResult(result, chat, undefined);
  assert.equal(chat.writeRequest?.reason, "Edit the file");
  const draft = createRunContext({ mode: "draft", actor: "t" });
  acceptResult(result, draft, undefined);
  assert.equal(draft.writeRequest, undefined);
  const already = createRunContext({ mode: "chat", access: "write", actor: "t" });
  acceptResult(result, already, undefined);
  assert.equal(already.writeRequest, undefined);
});

test("write sessions are labeled so they stand out in Agent Vault", () => {
  const label = describeRun({ mode: "chat", actor: "slack:jadden@infisical.com", runId: "abcdef1234", question: "Add hero variants", write: true });
  assert.match(label, /^Write: Add hero variants · jadden · abcdef12$/);
});

test("skills: only what Agent Vault installed, and none outside the sandbox", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { bundleSkills } = await import("./run-agent.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "skills-"));
  mkdirSync(path.join(dir, "skills/contentful"), { recursive: true });
  writeFileSync(path.join(dir, "skills/contentful/SKILL.md"), "---\nname: contentful\n---\n");
  mkdirSync(path.join(dir, "skills/empty"), { recursive: true });
  assert.deepEqual(bundleSkills(dir), ["contentful"]);
  assert.deepEqual(bundleSkills(undefined), []);
  assert.deepEqual(bundleSkills(path.join(dir, "missing")), []);
});

test("host keeps only chat renders that are Figma frames of seen files", () => {
  const key = "AbCdEfGhIjKlMnOpQrStUv";
  const good = { fileKey: key, nodeId: "1:2", name: "Cover", url: "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/x" };
  const result = {
    type: "result" as const, text: "", toolCalls: [], drafts: [],
    sources: [{ id: `figma:${key}`, kind: "figma" as const, title: "f" }],
    renders: [good, { ...good, nodeId: "3:4", url: "https://evil.example/x.png" }, { ...good, fileKey: "OtherFileKeyOtherFileKey", nodeId: "5:6" }],
  };
  const ctx = createRunContext({ mode: "chat", actor: "t" });
  acceptResult(result, ctx, undefined);
  assert.deepEqual([...ctx.renders.values()], [good]);
});
