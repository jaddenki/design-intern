// Figma "folders" are projects. FIGMA_PROJECT_IDS authorizes every file in those
// projects; FIGMA_FILE_KEYS still authorizes single files. File contents are read
// through the external MCP server; this module only decides which files are in scope.
import { envList, USE_FIXTURES } from "../config.js";
import { loadFixture } from "../fixtures.js";

const API_BASE = "https://api.figma.com/v1";
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_MS = 5 * 60_000;
const PROJECT_ID = /^\d+$/;

export interface FigmaFile {
  key: string;
  name: string;
  lastModified: string | null;
  project: string | null;
}

interface ProjectFilesResponse {
  name: string;
  files: { key: string; name: string; last_modified: string }[];
}

export function projectIds(): string[] {
  return envList("FIGMA_PROJECT_IDS").filter((id) => PROJECT_ID.test(id));
}

async function listProjectFiles(projectId: string): Promise<FigmaFile[]> {
  const token = process.env.FIGMA_API_KEY;
  if (!token) throw new Error("Missing FIGMA_API_KEY");
  const res = await fetch(`${API_BASE}/projects/${projectId}/files`, {
    headers: { "X-Figma-Token": token },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Figma API error for project ${projectId}: ${res.status} ${res.statusText}. ${body.slice(0, 300)}`.trim());
  }
  const data = (await res.json()) as ProjectFilesResponse;
  return data.files.map((f) => ({ key: f.key, name: f.name, lastModified: f.last_modified, project: data.name }));
}

/** Pure: merge single-file keys with project listings, project metadata winning. */
export function mergeFiles(fileKeys: string[], projectFiles: FigmaFile[]): FigmaFile[] {
  const byKey = new Map<string, FigmaFile>();
  for (const key of fileKeys) byKey.set(key, { key, name: key, lastModified: null, project: null });
  for (const f of projectFiles) byKey.set(f.key, f);
  return [...byKey.values()];
}

let cache: { at: number; files: FigmaFile[]; errors: string[] } | undefined;

/** Every authorized file. Project listing failures are reported, not thrown. */
export async function authorizedFiles(): Promise<{ files: FigmaFile[]; errors: string[] }> {
  const fileKeys = envList("FIGMA_FILE_KEYS");
  const ids = projectIds();
  if (USE_FIXTURES) {
    const meta = loadFixture<{ fileKey: string; name: string; lastModified: string }[]>("figma")
      .filter((f) => fileKeys.includes(f.fileKey))
      .map((f) => ({ key: f.fileKey, name: f.name, lastModified: f.lastModified, project: "Design (eval)" }));
    return { files: mergeFiles(fileKeys, meta), errors: [] };
  }
  if (ids.length === 0) return { files: mergeFiles(fileKeys, []), errors: [] };
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;

  const results = await Promise.allSettled(ids.map(listProjectFiles));
  const projectFiles = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const errors = results.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error)?.message ?? r.reason)] : []));
  cache = { at: Date.now(), files: mergeFiles(fileKeys, projectFiles), errors };
  return cache;
}

export async function authorizedFileKeys(): Promise<string[]> {
  return (await authorizedFiles()).files.map((f) => f.key);
}
