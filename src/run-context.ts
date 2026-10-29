// Per-run state shared by that run's tools. MCP servers are built per run (see
// agent.ts) so concurrent Slack requests never see each other's sources.
import { randomUUID } from "node:crypto";
import { DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS, USE_FIXTURES } from "./config.js";
import { storeSink, type DraftSink } from "./drafts/sink.js";
import { fixtureNow } from "./fixtures.js";

export type SourceKind = "linear" | "github" | "slack" | "figma" | "doc" | "note";

export interface SourceRef {
  /** Stable id the model cites, e.g. "linear:DES-142" or "github:org/repo#12". */
  id: string;
  kind: SourceKind;
  title: string;
  url?: string;
}

export type RunMode = "draft" | "chat";

export interface RunContext {
  runId: string;
  mode: RunMode;
  actor: string;
  now: Date;
  /** Every source a tool returned during this run; drafts may cite only these. */
  sources: Map<string, SourceRef>;
  /** Draft this run is discussing or revising, if any. */
  draftId?: string;
  /** Draft this run created or revised. */
  savedDraftId?: string;
  /** Widest window any source tool read this run. */
  window?: TimeWindow;
  toolCalls: { name: string; input: unknown; at: string }[];
  drafts: DraftSink;
}

export function createRunContext(opts: {
  mode: RunMode;
  actor: string;
  draftId?: string;
  seed?: SourceRef[];
  drafts?: DraftSink;
}): RunContext {
  const sources = new Map<string, SourceRef>();
  for (const s of opts.seed ?? []) sources.set(s.id, s);
  return {
    runId: randomUUID(),
    mode: opts.mode,
    actor: opts.actor,
    now: USE_FIXTURES ? fixtureNow() : new Date(),
    sources,
    draftId: opts.draftId,
    toolCalls: [],
    drafts: opts.drafts ?? storeSink,
  };
}

export function recordSource(ctx: RunContext, ref: SourceRef): void {
  ctx.sources.set(ref.id, ref);
}

export interface TimeWindow {
  since: Date;
  until: Date;
  days: number;
}

export function windowFor(ctx: RunContext, days?: number): TimeWindow {
  const d = Math.min(Math.max(Math.round(days ?? DEFAULT_WINDOW_DAYS), 1), MAX_WINDOW_DAYS);
  const w = { since: new Date(ctx.now.getTime() - d * 86_400_000), until: ctx.now, days: d };
  if (!ctx.window || w.days > ctx.window.days) ctx.window = w;
  return w;
}

export function inWindow(iso: string | null | undefined, w: TimeWindow): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= w.since.getTime() && t <= w.until.getTime();
}
