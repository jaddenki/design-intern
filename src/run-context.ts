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

/** Which Agent Vault bundle the run's session uses. Write tools exist only in "write". */
export type Access = "read" | "write";

/** A Figma frame rendered this run, which a draft may show as a preview. */
export interface FrameRender {
  fileKey: string;
  nodeId: string;
  name: string;
  url: string;
}

export interface RunContext {
  runId: string;
  mode: RunMode;
  access: Access;
  actor: string;
  /** Frames render_figma_frames returned, keyed "fileKey:nodeId"; previews may use only these. */
  renders: Map<string, FrameRender>;
  /** Set when a read run asked for a write session; the host decides whether to start one. */
  writeRequest?: { reason: string };
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
  access?: Access;
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
    access: opts.access ?? "read",
    actor: opts.actor,
    renders: new Map(),
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
