// The sandbox's output is untrusted: the host re-checks every draft it returns
// against the same rules the tools enforce, then rebuilds and saves it itself.
import { randomUUID } from "node:crypto";
import { getDraft, newDraftId, saveDraft } from "../drafts/store.js";
import type { Draft, DraftLine } from "../drafts/types.js";
import { validateLines, validateNotes } from "../drafts/validate.js";
import type { RunContext, SourceKind, SourceRef } from "../run-context.js";
import type { SandboxEvent } from "./job.js";

type Result = Extract<SandboxEvent, { type: "result" }>;

const KINDS: SourceKind[] = ["linear", "github", "slack", "figma", "doc", "note"];
const isString = (v: unknown): v is string => typeof v === "string";

function asSource(v: unknown): SourceRef | undefined {
  const s = v as SourceRef;
  if (!s || !isString(s.id) || !KINDS.includes(s.kind) || !isString(s.title)) return undefined;
  if (s.url !== undefined && !(isString(s.url) && /^https:\/\//.test(s.url))) return undefined;
  return { id: s.id, kind: s.kind, title: s.title.slice(0, 300), url: s.url };
}

function asLines(v: unknown): DraftLine[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const lines = v.map((l) =>
    l && isString(l.section) && isString(l.text) && Array.isArray(l.sourceIds) && l.sourceIds.every(isString)
      ? { id: randomUUID().slice(0, 8), section: l.section, text: l.text.trim(), sourceIds: [...new Set<string>(l.sourceIds)] }
      : undefined,
  );
  return lines.every(Boolean) ? (lines as DraftLine[]) : undefined;
}

/** Applies a sandbox result to the host's RunContext and saves at most one draft. */
export function acceptResult(result: Result, ctx: RunContext, seeded: Draft | undefined): void {
  for (const raw of result.sources ?? []) {
    const s = asSource(raw);
    if (s) ctx.sources.set(s.id, s);
  }
  if (Array.isArray(result.toolCalls)) ctx.toolCalls.push(...result.toolCalls.slice(0, 200));

  const drafts = Array.isArray(result.drafts) ? result.drafts : [];
  if (drafts.length === 0) return;
  if (drafts.length > 1) throw new Error("Sandbox returned more than one draft.");
  const candidate = drafts[0];

  const lines = asLines(candidate?.lines);
  const notes = Array.isArray(candidate?.notes) && candidate.notes.every(isString) ? candidate.notes : undefined;
  if (!lines || !notes) throw new Error("Sandbox returned a malformed draft.");
  const errors = [...validateLines(lines, ctx.sources), ...validateNotes(notes)];
  if (errors.length > 0) throw new Error(`Sandbox returned an invalid draft: ${errors.join(" ")}`);

  const now = new Date().toISOString();
  const sources = Object.fromEntries(ctx.sources);

  if (seeded) {
    const stored = getDraft(seeded.id);
    if (candidate.id !== seeded.id || !stored) throw new Error("Sandbox revised a draft it wasn't given.");
    if (stored.status !== "pending") throw new Error(`Draft ${stored.id} is already ${stored.status}.`);
    const last = candidate.history?.at(-1);
    stored.lines = lines;
    stored.notes = notes;
    stored.sources = { ...stored.sources, ...sources };
    stored.updatedAt = now;
    stored.history.push({ at: now, by: ctx.actor, action: "revised", detail: isString(last?.detail) ? last.detail.slice(0, 300) : undefined });
    saveDraft(stored);
    ctx.savedDraftId = stored.id;
    return;
  }

  if (ctx.mode !== "draft") throw new Error("Sandbox created a draft outside a drafting run.");
  const since = Date.parse(candidate.window?.since ?? "");
  const until = Date.parse(candidate.window?.until ?? "");
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error("Sandbox returned a draft with a bad window.");
  const draft: Draft = {
    id: newDraftId(ctx.now),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.actor,
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    lines,
    notes,
    sources,
    history: [{ at: now, by: ctx.actor, action: "created" }],
  };
  saveDraft(draft);
  ctx.savedDraftId = draft.id;
}
