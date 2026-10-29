import { tool } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { windowFor, type RunContext } from "../../run-context.js";
import { text } from "../../tool-result.js";
import { newDraftId } from "../store.js";
import { SECTIONS, type Draft, type DraftLine } from "../types.js";
import { validateLines, validateNotes, type ProposedLine } from "../validate.js";

const lineSchema = z.object({
  section: z.enum(SECTIONS).describe("Which part of the update this line belongs in."),
  text: z.string().describe("One crisp sentence a teammate can skim. No source ids in the text."),
  sourceIds: z.array(z.string()).describe("source_id values from tool results that support this line."),
});

const notesSchema = z
  .array(z.string())
  .describe("Short notes for the approver only: conflicts between sources, items left out and why, low-confidence calls.");

const toLines = (lines: ProposedLine[]): DraftLine[] =>
  lines.map((l) => ({
    id: randomUUID().slice(0, 8),
    section: l.section as DraftLine["section"],
    text: l.text.trim(),
    sourceIds: [...new Set(l.sourceIds)],
  }));

const rejection = (errors: string[]) =>
  text(`Draft not saved. Fix these and call the tool again:\n${errors.map((e) => `- ${e}`).join("\n")}`);

export function draftTools(ctx: RunContext) {
  const submit = tool(
    "submit_draft",
    "Save this week's design update as a PENDING draft for human approval. This does not post anything; a human reviews, edits, and approves it in the inbox or Slack. Every line must cite source_ids returned by tools in this run. Call once when the draft is complete; if it's rejected, fix the listed problems and call again.",
    { lines: z.array(lineSchema), notes: notesSchema },
    async (args) => {
      if (ctx.mode !== "draft") return text("submit_draft is only available when drafting the weekly update.");
      const errors = [...validateLines(args.lines, ctx.sources), ...validateNotes(args.notes)];
      if (errors.length > 0) return rejection(errors);

      const now = new Date().toISOString();
      const existing = ctx.savedDraftId ? ctx.drafts.get(ctx.savedDraftId) : undefined;
      const w = ctx.window ?? windowFor(ctx);
      const draft: Draft = existing ?? {
        id: newDraftId(ctx.now),
        status: "pending",
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.actor,
        window: { since: w.since.toISOString(), until: w.until.toISOString() },
        lines: [],
        notes: [],
        sources: {},
        history: [{ at: now, by: ctx.actor, action: "created" }],
      };
      draft.lines = toLines(args.lines);
      draft.notes = args.notes;
      draft.sources = Object.fromEntries(ctx.sources);
      draft.updatedAt = now;
      ctx.drafts.save(draft);
      ctx.savedDraftId = draft.id;
      return text(`Saved pending draft ${draft.id} with ${draft.lines.length} lines. It now waits for human approval.`);
    },
  );

  const revise = tool(
    "revise_draft",
    "Replace the lines of the pending draft being discussed, when a teammate asks for a change (drop, reword, add, or move an item). Pass the COMPLETE new list of lines, not a diff. Every line must cite known source_ids (the draft's original sources or ones fetched in this conversation). Does not post anything.",
    {
      lines: z.array(lineSchema),
      notes: notesSchema,
      reason: z.string().describe("One line on what changed and why, e.g. 'Dropped icon audit per Maya'."),
    },
    async (args) => {
      if (!ctx.draftId) return text("There's no draft in this conversation to revise.");
      const draft = ctx.drafts.get(ctx.draftId);
      if (!draft) return text(`Draft ${ctx.draftId} no longer exists.`);
      if (draft.status !== "pending") return text(`Draft ${draft.id} is already ${draft.status}; it can't be revised.`);
      const errors = [...validateLines(args.lines, ctx.sources), ...validateNotes(args.notes)];
      if (errors.length > 0) return rejection(errors);

      const now = new Date().toISOString();
      draft.lines = toLines(args.lines);
      draft.notes = args.notes;
      draft.sources = { ...draft.sources, ...Object.fromEntries(ctx.sources) };
      draft.updatedAt = now;
      draft.history.push({ at: now, by: ctx.actor, action: "revised", detail: args.reason });
      ctx.drafts.save(draft);
      ctx.savedDraftId = draft.id;
      return text(`Revised draft ${draft.id} (${draft.lines.length} lines). It's still pending approval.`);
    },
  );

  return [submit, revise];
}
