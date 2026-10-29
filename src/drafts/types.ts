import type { SourceRef } from "../run-context.js";

export const SECTIONS = ["shipped", "in_review", "in_progress", "decisions", "risks", "next"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<Section, string> = {
  shipped: "Shipped",
  in_review: "In review",
  in_progress: "In progress",
  decisions: "Decisions & discussion",
  risks: "Blocked & risks",
  next: "Up next",
};

export interface DraftLine {
  id: string;
  section: Section;
  text: string;
  sourceIds: string[];
  /** Project or theme the line rolls up under in the posted message, e.g. "Website fixes". */
  group?: string;
  /** Set when a human edited the agent's wording. */
  editedBy?: string;
}

export type DraftStatus = "pending" | "approved" | "rejected";

export interface DraftEvent {
  at: string;
  by: string;
  action: "created" | "revised" | "edited" | "approved" | "rejected" | "posted" | "preview_sent";
  detail?: string;
}

export interface Draft {
  id: string;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  window: { since: string; until: string };
  lines: DraftLine[];
  /** Gaps, conflicts, and judgment calls the agent wants the approver to see. */
  notes: string[];
  /** Every source the generating run saw, keyed by id; cited ones are a subset. */
  sources: Record<string, SourceRef>;
  history: DraftEvent[];
  /** A human's hand-edited Slack message; posts instead of the rendered template. */
  message?: { text: string; by: string; at: string };
  preview?: { channel: string; ts: string };
  posted?: { channel: string; ts?: string; dryRun: boolean };
}
