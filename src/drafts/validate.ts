// The traceability invariant: every draft line cites at least one source, and every
// cited id must be one a tool actually returned this run. The model can't invent a
// source, so every line in the inbox traces back to real activity.
import { containsSecret } from "../secret-guard.js";
import { FIGMA_IMAGE_URL, NODE_ID, normalizeNodeId } from "../figma/api.js";
import type { FrameRender, SourceRef } from "../run-context.js";
import { SECTIONS, type FramePreview, type Section } from "./types.js";

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

export const MAX_PREVIEWS = 4;
const MAX_CAPTION_CHARS = 150;
const FILE_KEY = /^[0-9a-zA-Z]{10,128}$/;

export interface ProposedPreview {
  fileKey: string;
  nodeId: string;
  caption?: string;
}

/**
 * Turn the agent's picks into previews. Each must be a frame rendered this run
 * (or already on the draft), so the model can't point Slack at an arbitrary URL.
 */
export function resolvePreviews(
  picks: ProposedPreview[],
  renders: ReadonlyMap<string, FrameRender>,
  existing: FramePreview[] = [],
): { previews: FramePreview[]; errors: string[] } {
  const errors: string[] = [];
  const previews: FramePreview[] = [];
  if (picks.length > MAX_PREVIEWS) errors.push(`Show at most ${MAX_PREVIEWS} previews.`);
  for (const pick of picks.slice(0, MAX_PREVIEWS)) {
    const nodeId = normalizeNodeId(pick.nodeId);
    const frame = renders.get(`${pick.fileKey}:${nodeId}`) ?? existing.find((p) => p.fileKey === pick.fileKey && p.nodeId === nodeId);
    if (!frame) {
      errors.push(`Preview ${pick.fileKey} ${nodeId} wasn't rendered this run; call render_figma_frames first.`);
      continue;
    }
    const caption = pick.caption?.trim().slice(0, MAX_CAPTION_CHARS);
    if (caption && containsSecret(caption)) {
      errors.push("A preview caption looks like it contains a credential; remove it.");
      continue;
    }
    previews.push({ fileKey: frame.fileKey, nodeId: frame.nodeId, name: frame.name, url: frame.url, ...(caption && { caption }) });
  }
  return { previews, errors };
}

/** Host-side re-check of previews a sandbox returned. Drops anything malformed. */
export function checkPreviews(raw: unknown, known: ReadonlyMap<string, SourceRef>): FramePreview[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_PREVIEWS) throw new Error("Draft previews are malformed.");
  return raw.map((p: Partial<FramePreview>) => {
    const ok =
      typeof p?.fileKey === "string" &&
      FILE_KEY.test(p.fileKey) &&
      typeof p.nodeId === "string" &&
      NODE_ID.test(p.nodeId) &&
      typeof p.url === "string" &&
      FIGMA_IMAGE_URL.test(p.url) &&
      typeof p.name === "string" &&
      (p.caption === undefined || (typeof p.caption === "string" && !containsSecret(p.caption))) &&
      known.has(`figma:${p.fileKey}`);
    if (!ok) throw new Error("A draft preview isn't a Figma frame rendered from an authorized file.");
    return {
      fileKey: p.fileKey!,
      nodeId: p.nodeId!,
      name: p.name!.slice(0, 120),
      url: p.url!,
      ...(p.caption && { caption: p.caption.slice(0, MAX_CAPTION_CHARS) }),
    };
  });
}

export function validateNotes(notes: string[]): string[] {
  return notes.some(containsSecret) ? ["A note looks like it contains a credential; remove it."] : [];
}
