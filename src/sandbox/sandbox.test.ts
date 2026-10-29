import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "design-intern-sandbox-"));

const { acceptResult } = await import("./accept.js");
const { encodeEvent, parseEventLine, sandboxEnv } = await import("./job.js");
const { bootstrapScript, modalConfig } = await import("./runner.js");
const { pinnedDependencies } = await import("./image.js");
const { memorySink } = await import("../drafts/sink.js");
const { createRunContext } = await import("../run-context.js");
const { describeRun, sessionLabel } = await import("./vault.js");
const { containsSecret } = await import("../secret-guard.js");
const { getDraft, newDraftId, saveDraft } = await import("../drafts/store.js");
type Draft = import("../drafts/types.js").Draft;

const src = { id: "linear:DES-1", kind: "linear" as const, title: "DES-1", url: "https://linear.app/x" };
const line = (sourceIds = ["linear:DES-1"]) => ({ id: "x", section: "shipped" as const, text: "Sidebar shipped.", sourceIds });
const window = { since: "2026-10-16T00:00:00.000Z", until: "2026-10-23T00:00:00.000Z" };

function candidate(over: Partial<Draft> = {}): Draft {
  return {
    id: "d_20261023evil00",
    status: "approved",
    createdAt: "",
    updatedAt: "",
    createdBy: "someone-else",
    window,
    lines: [line()],
    notes: [],
    sources: {},
    history: [],
    ...over,
  };
}

const result = (drafts: Draft[], sources: unknown[] = [src]) =>
  ({ type: "result", text: "ok", sources, toolCalls: [], drafts }) as Parameters<typeof acceptResult>[0];

test("sandbox env forwards scope config and placeholders, never real credentials", () => {
  const env = sandboxEnv({
    LINEAR_TEAM_KEYS: "DES",
    SLACK_BOT_TOKEN: "xoxb-real-token-value",
    GITHUB_TOKEN: "ghp_real",
    MODAL_TOKEN_SECRET: "as-secret",
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "secret",
  });
  assert.equal(env.LINEAR_TEAM_KEYS, "DES");
  assert.equal(env.SLACK_BOT_TOKEN, "__slack_bot_token__");
  assert.equal(env.GITHUB_TOKEN, "__github_token__");
  assert.equal(env.ANTHROPIC_API_KEY, "__anthropic_api_key__");
  assert.equal(env.LINEAR_API_KEY, undefined);
  assert.ok(!JSON.stringify(env).includes("real") && !JSON.stringify(env).includes("secret"));
});

test("session labels fit Agent Vault's rules", () => {
  assert.equal(sessionLabel("design-intern · chat · slack:a@b.com · 3f9a2c1e"), "design-intern · chat · slack:a@b.com · 3f9a2c1e");
  assert.equal(sessionLabel("a\nb\tc\u200bd"), "a b c d");
  assert.equal(sessionLabel("x".repeat(200)).length, 128);
});

test("session labels lead with the task, then who asked and the run id", () => {
  const runId = "f283e746-0000-0000-0000-000000000000";
  assert.equal(
    describeRun({ mode: "chat", actor: "slack:jadden@infisical.com", runId, question: "give me full white logo png" }),
    "Give me full white logo png · jadden · f283e746",
  );
  assert.equal(describeRun({ mode: "draft", actor: "web:Jadden", runId }), "Weekly design update draft · Jadden · f283e746");
  assert.equal(
    describeRun({ mode: "chat", actor: "slack:j@x.com", runId, question: "drop the banner line", draftWindow: { since: "2026-10-22T00:00:00Z", until: "2026-10-29T00:00:00Z" } }),
    "Revise Oct 22 – Oct 29 draft: Drop the banner line · j · f283e746",
  );
  assert.equal(
    describeRun({ mode: "chat", actor: "cli", runId, question: "use xoxb-123456789012-abcdefgh", secretLike: containsSecret }),
    "Chat question · cli · f283e746",
  );
  assert.ok(describeRun({ mode: "chat", actor: "cli", runId, question: "x".repeat(300) }).length <= 128);
});

test("events round-trip; other stdout is ignored", () => {
  assert.deepEqual(parseEventLine(encodeEvent({ type: "progress", label: "hi" }).trim()), { type: "progress", label: "hi" });
  assert.equal(parseEventLine("Claude Code banner"), undefined);
  assert.equal(parseEventLine("@@design-intern {not json"), undefined);
});

test("bootstrap reads the token from stdin, not argv", () => {
  const script = bootstrapScript("SHA256:AA:BB");
  assert.match(script, /read -r INFISICAL_AGENT_VAULT_SESSION_TOKEN/);
  assert.match(script, /--ca-fingerprint='SHA256:AA:BB'/);
  assert.doesNotMatch(script, /agv_/);
});

test("modal config fails closed and names what's missing", () => {
  assert.throws(() => modalConfig({}), /AGENT_VAULT_CA_FINGERPRINT.*MODAL_TOKEN_SECRET/);
});

test("image pins every runtime dependency except the host-only Modal SDK", () => {
  const deps = pinnedDependencies();
  assert.ok(deps.some((d) => /^@anthropic-ai\/claude-agent-sdk@\d/.test(d)));
  assert.ok(!deps.some((d) => d.startsWith("modal@")));
});

test("memory sink keeps the seed and reports only what was saved", () => {
  const sink = memorySink(candidate({ id: "d_20261023seed00" }));
  assert.ok(sink.get("d_20261023seed00"));
  assert.deepEqual(sink.saved(), []);
  sink.save(candidate({ id: "d_20261023new000" }));
  assert.deepEqual(sink.saved().map((d) => d.id), ["d_20261023new000"]);
});

test("host rebuilds a new draft: its own id, pending, its own actor", () => {
  const ctx = createRunContext({ mode: "draft", actor: "web:Maya" });
  acceptResult(result([candidate()]), ctx, undefined);
  const saved = getDraft(ctx.savedDraftId!)!;
  assert.notEqual(saved.id, "d_20261023evil00");
  assert.equal(saved.status, "pending");
  assert.equal(saved.createdBy, "web:Maya");
  assert.deepEqual(Object.keys(saved.sources), ["linear:DES-1"]);
});

test("a check-in is a citable source on the host", () => {
  const note = { id: "note:checkin", kind: "note" as const, title: "Check-in from web:Jadden" };
  const ctx = createRunContext({ mode: "draft", actor: "web:Jadden", seed: [note] });
  acceptResult(result([candidate({ lines: [line(["note:checkin"])] })], [note]), ctx, undefined);
  assert.equal(getDraft(ctx.savedDraftId!)!.sources["note:checkin"]?.kind, "note");
});

test("host rejects uncited lines, bad sources, and drafts outside drafting runs", () => {
  const ctx = () => createRunContext({ mode: "draft", actor: "t" });
  assert.throws(() => acceptResult(result([candidate({ lines: [line(["linear:FAKE"])] })]), ctx(), undefined), /invalid draft/);
  assert.throws(() => acceptResult(result([candidate()], [{ ...src, url: "javascript:alert(1)" }]), ctx(), undefined), /invalid draft/);
  assert.throws(() => acceptResult(result([candidate(), candidate()]), ctx(), undefined), /more than one/);
  assert.throws(() => acceptResult(result([candidate()]), createRunContext({ mode: "chat", actor: "t" }), undefined), /outside a drafting run/);
  assert.throws(() => acceptResult(result([candidate({ lines: "nope" as never })]), ctx(), undefined), /malformed/);
});

test("host applies a revision only to the draft it handed over, and only while pending", () => {
  const now = new Date().toISOString();
  const stored: Draft = { ...candidate(), id: newDraftId(), status: "pending", createdAt: now, updatedAt: now, createdBy: "t", sources: { [src.id]: src } };
  saveDraft(stored);
  const ctx = () => createRunContext({ mode: "chat", actor: "slack:maya", draftId: stored.id, seed: [src] });

  assert.throws(() => acceptResult(result([candidate({ id: newDraftId() })]), ctx(), stored), /wasn't given/);

  const revised = candidate({ id: stored.id, history: [{ at: now, by: "x", action: "revised", detail: "Dropped icons" }] });
  const c = ctx();
  acceptResult(result([revised]), c, stored);
  const after = getDraft(stored.id)!;
  assert.equal(after.status, "pending");
  assert.equal(after.history.at(-1)?.by, "slack:maya");
  assert.equal(after.history.at(-1)?.detail, "Dropped icons");

  saveDraft({ ...after, status: "approved" });
  assert.throws(() => acceptResult(result([revised]), ctx(), stored), /already approved/);
});
