import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "./config.js";
import { mergeFiles } from "./figma/projects.js";
import { readDoc, resolveDocPath, searchDocs } from "./knowledge/store.js";
import { msUntilNextWeekly, parseSlot } from "./schedule.js";
import { containsSecret } from "./secret-guard.js";
import { authenticate } from "./web/server.js";

const KB = path.join(APP_ROOT, "fixtures/knowledge");

test("knowledge: search finds the brand doc", () => {
  assert.equal(searchDocs("brand colors", KB)[0]?.doc.path, "brand.md");
  assert.deepEqual(searchDocs("typeface marketing", KB), []);
});

test("knowledge: paths can't escape the folder", () => {
  assert.equal(resolveDocPath("../meta.json", KB), undefined);
  assert.equal(resolveDocPath("/etc/passwd", KB), undefined);
  assert.equal(readDoc("../../package.json", KB), undefined);
  assert.equal(readDoc("brand.md", KB)?.title, "Brand colors (sample)");
});

test("schedule: parses slots and finds the next one", () => {
  assert.throws(() => parseSlot("someday 10:00"));
  assert.equal(parseSlot(""), undefined);
  const slot = parseSlot("fri 10:00", "UTC")!;
  // Thu 2026-10-22 10:00 UTC → Fri 10:00 is 24h away.
  assert.equal(msUntilNextWeekly(slot, new Date("2026-10-22T10:00:00Z")), 86_400_000);
  // Exactly at the slot rolls to next week.
  assert.equal(msUntilNextWeekly(slot, new Date("2026-10-23T10:00:00Z")), 7 * 86_400_000);
});

test("secret guard catches tokens and vault placeholders, not prose", () => {
  assert.ok(containsSecret("xoxb-123456789012-abcdefgh"));
  assert.ok(containsSecret("lin_api_abcdefghijklmnopqrstuv"));
  assert.ok(containsSecret("use __anthropic_api_key__"));
  assert.ok(!containsSecret("The secrets sidebar shipped__ on Tuesday"));
  assert.ok(!containsSecret("Empty states slipped to next week."));
});

test("web auth: Basic with the right password, name becomes the actor", () => {
  const header = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;
  assert.equal(authenticate(header("Maya:pw"), "pw"), "Maya");
  assert.equal(authenticate(header("Maya:nope"), "pw"), undefined);
  assert.equal(authenticate(header(":pw"), "pw"), undefined);
  assert.equal(authenticate(header("Maya:pw"), ""), undefined);
  assert.equal(authenticate(undefined, "pw"), undefined);
});

test("models: Haiku for reference and asset questions, Sonnet for draft talk, Opus drafts", async () => {
  const { modelFor } = await import("./run-agent.js");
  const { CHAT_MODEL, DRAFT_MODEL, REFERENCE_MODEL } = await import("./config.js");
  assert.equal(modelFor("draft"), DRAFT_MODEL);
  assert.equal(modelFor("chat", { question: "give me the white logo as an svg" }), REFERENCE_MODEL);
  assert.equal(modelFor("chat", { hasDraft: true, question: "what's our primary color?" }), REFERENCE_MODEL);
  assert.equal(modelFor("chat", { hasDraft: true, question: "why is the logo refresh line a risk?" }), CHAT_MODEL);
  assert.equal(modelFor("chat", { hasDraft: true, question: "drop the icon line" }), CHAT_MODEL);
  assert.equal(modelFor("chat", { question: "can you update the draft?" }), CHAT_MODEL);
});

test("figma: project files merge with single file keys, project metadata wins", () => {
  const files = mergeFiles(["a", "b"], [{ key: "b", name: "Onboarding", lastModified: "2026-10-22T00:00:00Z", project: "Design" }, { key: "c", name: "Icons", lastModified: null, project: "Design" }]);
  assert.deepEqual(files.map((f) => f.key).sort(), ["a", "b", "c"]);
  assert.equal(files.find((f) => f.key === "b")?.name, "Onboarding");
});
