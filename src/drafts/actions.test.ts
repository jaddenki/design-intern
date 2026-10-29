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

test("the posted message follows the template: grouped last week, numbered priorities", async () => {
  const { renderDraftMrkdwn } = await import("./render.js");
  const d = seed();
  d.lines = [
    { id: "a", section: "shipped", text: "Fix 1", sourceIds: [], group: "Website fixes" },
    { id: "b", section: "in_progress", text: "D1", sourceIds: [], group: "Misc design" },
    { id: "c", section: "shipped", text: "Fix 2", sourceIds: [], group: "Website fixes" },
    { id: "n1", section: "next", text: "Slideshow", sourceIds: [] },
    { id: "n2", section: "next", text: "Website fixes", sourceIds: [] },
  ];
  const out = renderDraftMrkdwn(d, "hi :evilplan:\n{{last_week}}\n---\n{{priorities}}\n:bufo-yay: {{unknown}}");
  assert.equal(
    out,
    "hi :evilplan:\n• Website fixes:\n    ◦ Fix 1\n    ◦ Fix 2\n• Misc design:\n    ◦ D1 _(in progress)_\n---\n1. Slideshow\n2. Website fixes\n:bufo-yay: {{unknown}}",
  );
});

test("a hand-edited message is what posts; reset goes back to the template; secrets are refused", async () => {
  const { editMessage } = await import("./actions.js");
  const { finalMessage, renderDraftMrkdwn } = await import("./render.js");
  const d = seed();
  const edited = await editMessage(d.id, "web:Jadden", "helloooooo custom text");
  assert.equal(finalMessage(edited), "helloooooo custom text");
  assert.equal(edited.history.at(-1)?.detail, "edited the Slack message");
  await assert.rejects(editMessage(d.id, "web:Jadden", "token xoxb-123456789012-abcdef"));
  const reset = await editMessage(d.id, "web:Jadden", null);
  assert.equal(finalMessage(reset), renderDraftMrkdwn(reset));
  const approved = await approveDraft(d.id, "web:Jadden");
  await assert.rejects(editMessage(approved.id, "web:Jadden", "too late"));
});
