import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "design-intern-test-"));
process.env.DATA_SOURCE = "fixtures";
delete process.env.SLACK_BOT_TOKEN;

const { approveDraft, editDraft, rejectDraft } = await import("./actions.js");
const { getDraft, newDraftId, saveDraft } = await import("./store.js");
type Draft = import("./types.js").Draft;

function seed(): Draft {
  const now = new Date().toISOString();
  const draft: Draft = {
    id: newDraftId(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    window: { since: now, until: now },
    lines: [
      { id: "l1", section: "shipped", text: "Sidebar shipped.", sourceIds: ["linear:DES-142"] },
      { id: "l2", section: "decisions", text: "Lunch is tacos.", sourceIds: ["linear:DES-142"] },
    ],
    notes: [],
    sources: { "linear:DES-142": { id: "linear:DES-142", kind: "linear", title: "DES-142", url: "https://linear.app/x" } },
    history: [],
  };
  saveDraft(draft);
  return draft;
}

test("humans can reword, move, and remove lines; history records it", async () => {
  const d = seed();
  const edited = await editDraft(d.id, "web:Maya", [
    { id: "l1", text: "New secrets sidebar is live.", section: "shipped" },
    { id: "l2", remove: true },
  ]);
  assert.equal(edited.lines.length, 1);
  assert.equal(edited.lines[0].editedBy, "web:Maya");
  assert.equal(edited.history.at(-1)?.action, "edited");
});

test("edits reject empty text, unknown sections, and credentials", async () => {
  const d = seed();
  await assert.rejects(editDraft(d.id, "web:Maya", [{ id: "l1", text: "  " }]));
  await assert.rejects(editDraft(d.id, "web:Maya", [{ id: "l1", section: "done" }]));
  await assert.rejects(editDraft(d.id, "web:Maya", [{ id: "l1", text: "xoxb-123456789012-abcdef" }]));
});

test("approval in demo mode is a dry run and can't happen twice", async () => {
  const d = seed();
  const approved = await approveDraft(d.id, "web:Maya");
  assert.equal(approved.status, "approved");
  assert.equal(approved.posted?.dryRun, true);
  assert.deepEqual(
    getDraft(d.id)?.history.map((e) => e.action),
    ["approved", "posted"],
  );
  await assert.rejects(approveDraft(d.id, "web:Maya"), /already approved/);
  await assert.rejects(editDraft(d.id, "web:Maya", []), /already approved/);
});

test("rejected drafts can't be approved", async () => {
  const d = seed();
  await rejectDraft(d.id, "slack:maya@x.com", "too long");
  await assert.rejects(approveDraft(d.id, "web:Maya"), /already rejected/);
});
