import type { SourceRef } from "../run-context.js";
import { SECTION_LABELS, SECTIONS, type Draft } from "./types.js";

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

/** Slack mrkdwn for the posted update: sections in fixed order, sources as compact links. */
export function renderDraftMrkdwn(draft: Draft): string {
  const out = [`*${draftTitle(draft)}*`];
  for (const section of SECTIONS) {
    const lines = draft.lines.filter((l) => l.section === section);
    if (lines.length === 0) continue;
    out.push("", `*${SECTION_LABELS[section]}*`);
    for (const line of lines) {
      const refs = line.sourceIds
        .map((id) => draft.sources[id])
        .filter((r): r is SourceRef => Boolean(r))
        .map((r) => (r.url ? `<${r.url}|${escapeMrkdwn(sourceLabel(r))}>` : escapeMrkdwn(sourceLabel(r))));
      out.push(`• ${escapeMrkdwn(line.text)}${refs.length ? `  ${refs.join(" · ")}` : ""}`);
    }
  }
  return out.join("\n");
}

/** Plain-text form the agent reads when a chat is about this draft. */
export function renderDraftForAgent(draft: Draft): string {
  const lines = draft.lines.map(
    (l, i) => `${i + 1}. [${l.section}] ${l.text}  (sources: ${l.sourceIds.join(", ")})${l.editedBy ? ` [edited by ${l.editedBy}]` : ""}`,
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
