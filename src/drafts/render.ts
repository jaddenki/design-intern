import { readFileSync } from "node:fs";
import { UPDATE_TEMPLATE } from "../config.js";
import type { SourceRef } from "../run-context.js";
import { SECTION_LABELS, SECTIONS, type Draft, type DraftLine } from "./types.js";

export function sourceLabel(ref: SourceRef): string {
  switch (ref.kind) {
    case "linear":
      return ref.id.slice("linear:".length);
    case "github":
      return `#${ref.id.split("#").pop()}`;
    case "slack":
      return "thread";
    case "figma":
      return "Figma";
    case "doc":
      return ref.title;
    case "note":
      return "check-in";
  }
}

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function draftTitle(draft: Draft): string {
  return `Design update · ${fmtDay(draft.window.since)} – ${fmtDay(draft.window.until)}`;
}

const escapeMrkdwn = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const DEFAULT_TEMPLATE = "*Last week:*\n{{last_week}}\n\n*This week's priorities:*\n{{priorities}}";
const NOT_DONE: Partial<Record<DraftLine["section"], string>> = { in_review: "in review", in_progress: "in progress", risks: "blocked" };

export function loadTemplate(file = UPDATE_TEMPLATE): string {
  try {
    return readFileSync(file, "utf8").trimEnd();
  } catch {
    return DEFAULT_TEMPLATE;
  }
}

/** Everything except "next", grouped by line.group (falling back to the section name), in draft order. */
export function renderLastWeek(draft: Draft): string {
  const groups = new Map<string, string[]>();
  const order: readonly string[] = SECTIONS.filter((s) => s !== "next");
  const lines = draft.lines.filter((l) => l.section !== "next").sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
  for (const line of lines) {
    const group = line.group?.trim() || SECTION_LABELS[line.section];
    const status = NOT_DONE[line.section];
    const items = groups.get(group) ?? [];
    items.push(`    ◦ ${escapeMrkdwn(line.text)}${status ? ` _(${status})_` : ""}`);
    groups.set(group, items);
  }
  if (groups.size === 0) return "• Nothing to report.";
  return [...groups].map(([group, items]) => [`• ${escapeMrkdwn(group)}:`, ...items].join("\n")).join("\n");
}

export function renderPriorities(draft: Draft): string {
  const next = draft.lines.filter((l) => l.section === "next");
  return next.length ? next.map((l, i) => `${i + 1}. ${escapeMrkdwn(l.text)}`).join("\n") : "_Nothing planned yet._";
}

/** What actually posts: a human's edited message if there is one, else the template. */
export function finalMessage(draft: Draft): string {
  return draft.message?.text ?? renderDraftMrkdwn(draft);
}

/** The Slack message rendered from templates/weekly-update.md. */
export function renderDraftMrkdwn(draft: Draft, template = loadTemplate()): string {
  const values: Record<string, () => string> = {
    last_week: () => renderLastWeek(draft),
    priorities: () => renderPriorities(draft),
    date_range: () => `${fmtDay(draft.window.since)} – ${fmtDay(draft.window.until)}`,
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, key: string) => values[key]?.() ?? raw);
}

/** Plain-text form the agent reads when a chat is about this draft. */
export function renderDraftForAgent(draft: Draft): string {
  const lines = draft.lines.map(
    (l, i) => `${i + 1}. [${l.section}${l.group ? ` · ${l.group}` : ""}] ${l.text}  (sources: ${l.sourceIds.join(", ")})${l.editedBy ? ` [edited by ${l.editedBy}]` : ""}`,
  );
  const notes = draft.notes.map((n) => `- ${n}`);
  const sources = Object.values(draft.sources).map((s) => `- ${s.id}: ${s.title}${s.url ? ` (${s.url})` : ""}`);
  return [
    `Draft ${draft.id} (${draft.status}) covering ${draft.window.since} → ${draft.window.until}`,
    "Lines:",
    ...lines,
    notes.length ? "Notes for the approver:" : "",
    ...notes,
    "Sources the drafting run saw:",
    ...sources,
  ]
    .filter(Boolean)
    .join("\n");
}
