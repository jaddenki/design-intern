// The traceability invariant: every draft line cites at least one source, and every
// cited id must be one a tool actually returned this run. The model can't invent a
// source, so every line in the inbox traces back to real activity.
import { containsSecret } from "../secret-guard.js";
import type { SourceRef } from "../run-context.js";
import { SECTIONS, type Section } from "./types.js";

export const MAX_LINES = 30;
const MAX_LINE_CHARS = 400;
const MAX_GROUP_CHARS = 40;

export interface ProposedLine {
  section: string;
  text: string;
  sourceIds: string[];
  group?: string;
}

export function validateLines(lines: ProposedLine[], known: ReadonlyMap<string, SourceRef>): string[] {
  const errors: string[] = [];
  if (lines.length === 0) errors.push("The draft has no lines.");
  if (lines.length > MAX_LINES) errors.push(`The draft has ${lines.length} lines; keep it to ${MAX_LINES} or fewer.`);
  lines.forEach((line, i) => {
    const n = `Line ${i + 1}`;
    if (!SECTIONS.includes(line.section as Section)) errors.push(`${n}: unknown section "${line.section}".`);
    if (!line.text.trim()) errors.push(`${n}: text is empty.`);
    if (line.text.length > MAX_LINE_CHARS) errors.push(`${n}: text is over ${MAX_LINE_CHARS} characters.`);
    if (containsSecret(line.text)) errors.push(`${n}: text looks like it contains a credential; remove it.`);
    if (line.group !== undefined && line.group.length > MAX_GROUP_CHARS) errors.push(`${n}: group is over ${MAX_GROUP_CHARS} characters.`);
    if (line.group && containsSecret(line.group)) errors.push(`${n}: group looks like it contains a credential; remove it.`);
    if (line.sourceIds.length === 0) errors.push(`${n}: cites no sources. Every line needs at least one source_id.`);
    const unknown = line.sourceIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      errors.push(`${n}: cites ${unknown.join(", ")}, which no tool returned this run. Cite only source_ids you've seen.`);
    }
  });
  return errors;
}

export function validateNotes(notes: string[]): string[] {
  return notes.some(containsSecret) ? ["A note looks like it contains a credential; remove it."] : [];
}
