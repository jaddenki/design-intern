// Figma "folders" are projects. FIGMA_PROJECT_IDS authorizes every file in those
// projects; FIGMA_FILE_KEYS still authorizes single files.
import { envList, USE_FIXTURES } from "../config.js";
import { loadFixture } from "../fixtures.js";
import { figmaGet } from "./api.js";

const CACHE_MS = 5 * 60_000;
const PROJECT_ID = /^\d+$/;

export interface FigmaFile {
  key: string;
  name: string;
  lastModified: string | null;
  project: string | null;
}

interface FolderFilesResponse {
  name?: string;
  folder?: { name?: string };
  files?: { key?: string; file_key?: string; name?: string; last_modified?: string; updated_at?: string }[];
}

export function projectIds(): string[] {
  return envList("FIGMA_PROJECT_IDS").filter((id) => PROJECT_ID.test(id));
}

// Figma renamed projects to folders (v2, folders:read); v1 still serves projects:read tokens.
async function listProjectFiles(projectId: string): Promise<FigmaFile[]> {
  const data = await figmaGet<FolderFilesResponse>(`/folders/${projectId}/files`, "v2")
    .catch(() => figmaGet<FolderFilesResponse>(`/projects/${projectId}/files`))
    .catch((err: Error) => {
      throw new Error(`Couldn't list Figma folder ${projectId}: ${err.message}`);
    });
  const folder = data.name ?? data.folder?.name ?? `Folder ${projectId}`;
  const files = (data.files ?? []).flatMap((f) => {
    const key = f.key ?? f.file_key;
    return key ? [{ key, name: f.name ?? key, lastModified: f.last_modified ?? f.updated_at ?? null, project: folder }] : [];
  });
  if (files.length === 0 && !Array.isArray(data.files)) throw new Error(`Unexpected Figma folder response: ${JSON.stringify(data).slice(0, 300)}`);
  return files;
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
