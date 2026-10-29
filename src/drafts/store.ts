// File-backed draft store (one JSON per draft) plus an append-only run log. Good
// enough for one instance; Render needs a persistent disk mounted at DATA_DIR.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { Draft } from "./types.js";

const DRAFT_ID = /^d_[a-z0-9]{6,32}$/;

function draftsDir(): string {
  const dir = path.join(DATA_DIR, "drafts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function newDraftId(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `d_${stamp}${Math.random().toString(36).slice(2, 8)}`;
}

export function getDraft(id: string): Draft | undefined {
  if (!DRAFT_ID.test(id)) return undefined;
  try {
    return JSON.parse(readFileSync(path.join(draftsDir(), `${id}.json`), "utf8")) as Draft;
  } catch {
    return undefined;
  }
}

export function saveDraft(draft: Draft): void {
  if (!DRAFT_ID.test(draft.id)) throw new Error(`Invalid draft id ${draft.id}`);
  const file = path.join(draftsDir(), `${draft.id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(draft, null, 2));
  renameSync(tmp, file);
}

export function listDrafts(): Draft[] {
  return readdirSync(draftsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => getDraft(f.slice(0, -5)))
    .filter((d): d is Draft => Boolean(d))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findDraftByPreview(channel: string, ts: string): Draft | undefined {
  return listDrafts().find((d) => d.preview?.channel === channel && d.preview.ts === ts);
}

export interface RunLogEntry {
  runId: string;
  mode: string;
  actor: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  toolCalls: { name: string; input: unknown; at: string }[];
  sourcesSeen: number;
  draftId?: string;
  error?: string;
}

export function appendRunLog(entry: RunLogEntry): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(path.join(DATA_DIR, "runs.jsonl"), `${JSON.stringify(entry)}\n`);
}
