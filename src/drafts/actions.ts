// Every state change a human or the scheduler can make to a draft. Both surfaces
// (Slack buttons and the web inbox) call these, so the rules live in one place.
import { weeklyDraftPrompt } from "../prompt.js";
import { runAgent } from "../run-agent.js";
import { createRunContext } from "../run-context.js";
import { containsSecret } from "../secret-guard.js";
import { postApprovedUpdate, refreshPreview, sendForApproval } from "../slack-approval.js";
import { getDraft, saveDraft } from "./store.js";
import { SECTIONS, type Draft, type DraftEvent, type Section } from "./types.js";

let generating: Promise<{ draft: Draft; summary: string }> | undefined;

function log(draft: Draft, by: string, action: DraftEvent["action"], detail?: string): void {
  const at = new Date().toISOString();
  draft.history.push({ at, by, action, detail });
  draft.updatedAt = at;
}

function requirePending(id: string): Draft {
  const draft = getDraft(id);
  if (!draft) throw new Error(`Draft ${id} not found.`);
  if (draft.status !== "pending") throw new Error(`Draft ${id} is already ${draft.status}.`);
  return draft;
}

/** One generation at a time; a second caller gets the in-flight run. */
export function generateDraft(
  actor: string,
  onProgress?: (m: string) => void,
  checkIn?: string,
): Promise<{ draft: Draft; summary: string }> {
  generating ??= (async () => {
    try {
      const now = createRunContext({ mode: "draft", actor }).now;
      const { text, ctx } = await runAgent(weeklyDraftPrompt(now), { mode: "draft", actor, onProgress, checkIn });
      const draft = ctx.savedDraftId ? getDraft(ctx.savedDraftId) : undefined;
      if (!draft) throw new Error(`The agent finished without saving a draft. It said: ${text.slice(0, 300)}`);
      const preview = await sendForApproval(draft).catch((err) => {
        console.error("Failed to send approval preview:", err);
        return undefined;
      });
      if (preview) {
        draft.preview = preview;
        log(draft, "system", "preview_sent", preview.channel);
        saveDraft(draft);
      }
      return { draft, summary: text };
    } finally {
      generating = undefined;
    }
  })();
  return generating;
}

export function isGenerating(): boolean {
  return Boolean(generating);
}

export async function approveDraft(id: string, by: string): Promise<Draft> {
  const draft = requirePending(id);
  draft.status = "approved";
  log(draft, by, "approved");
  saveDraft(draft);
  try {
    draft.posted = await postApprovedUpdate(draft);
    log(draft, "system", "posted", draft.posted.dryRun ? `dry run (${draft.posted.channel})` : draft.posted.channel);
  } catch (err) {
    // Roll back so a failed post doesn't leave an "approved" update nobody saw.
    draft.status = "pending";
    log(draft, "system", "edited", `post failed, back to pending: ${err instanceof Error ? err.message : String(err)}`);
    saveDraft(draft);
    throw err;
  }
  saveDraft(draft);
  await refreshPreview(draft);
  return draft;
}

export async function rejectDraft(id: string, by: string, reason?: string): Promise<Draft> {
  const draft = requirePending(id);
  draft.status = "rejected";
  log(draft, by, "rejected", reason);
  saveDraft(draft);
  await refreshPreview(draft);
  return draft;
}

export interface LineEdit {
  id: string;
  text?: string;
  section?: string;
  remove?: boolean;
}

/** Human edits: reword, move, or drop lines. Humans can't attach new sources. */
export async function editDraft(id: string, by: string, edits: LineEdit[]): Promise<Draft> {
  const draft = requirePending(id);
  const changes: string[] = [];
  for (const edit of edits) {
    const line = draft.lines.find((l) => l.id === edit.id);
    if (!line) throw new Error(`Line ${edit.id} isn't in draft ${id}.`);
    if (edit.remove) {
      draft.lines = draft.lines.filter((l) => l.id !== edit.id);
      changes.push(`removed "${line.text.slice(0, 40)}"`);
      continue;
    }
    if (edit.text !== undefined && edit.text.trim() !== line.text) {
      const next = edit.text.trim();
      if (!next) throw new Error("A line can't be empty; remove it instead.");
      if (containsSecret(next)) throw new Error("That text looks like it contains a credential.");
      line.text = next;
      line.editedBy = by;
      changes.push(`reworded ${line.id}`);
    }
    if (edit.section !== undefined && edit.section !== line.section) {
      if (!SECTIONS.includes(edit.section as Section)) throw new Error(`Unknown section ${edit.section}.`);
      line.section = edit.section as Section;
      line.editedBy = by;
      changes.push(`moved ${line.id} to ${edit.section}`);
    }
  }
  if (changes.length > 0) {
    log(draft, by, "edited", changes.join("; "));
    saveDraft(draft);
    await refreshPreview(draft);
  }
  return draft;
}
