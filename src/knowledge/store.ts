// Design reference knowledge: markdown files in DESIGN_KNOWLEDGE_DIR, which the team
// curates and version-controls. That folder is the only place reference answers may
// come from; paths are resolved inside it and anything escaping it is refused.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { KNOWLEDGE_DIR } from "../config.js";

const MAX_DOC_CHARS = 20_000;
const MAX_RESULTS = 5;
const SNIPPET_RADIUS = 160;

export interface KnowledgeDoc {
  /** Path relative to the knowledge dir, e.g. "brand/colors.md". */
  path: string;
  title: string;
  body: string;
}

function walk(dir: string, prefix = ""): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    if (name.startsWith(".")) return [];
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) return walk(full, rel);
    return /\.(md|markdown|txt)$/i.test(name) && name.toLowerCase() !== "readme.md" ? [rel] : [];
  });
}

/** Resolve a relative doc path inside the knowledge dir, or undefined if it escapes. */
export function resolveDocPath(rel: string, root = KNOWLEDGE_DIR): string | undefined {
  if (path.isAbsolute(rel)) return undefined;
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : undefined;
}

export function loadDocs(root = KNOWLEDGE_DIR): KnowledgeDoc[] {
  return walk(root).map((rel) => {
    const body = readFileSync(path.join(root, rel), "utf8").slice(0, MAX_DOC_CHARS);
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? rel;
    return { path: rel, title, body };
  });
}

export function readDoc(rel: string, root = KNOWLEDGE_DIR): KnowledgeDoc | undefined {
  const full = resolveDocPath(rel, root);
  if (!full) return undefined;
  return loadDocs(root).find((d) => path.resolve(root, d.path) === full);
}

const terms = (q: string) =>
  q
    .toLowerCase()
    .split(/[^a-z0-9#]+/)
    .filter((t) => t.length > 2);

/** Rank docs by term hits (title hits count triple). Pure apart from the read. */
export function searchDocs(query: string, root = KNOWLEDGE_DIR): { doc: KnowledgeDoc; score: number; snippet: string }[] {
  const qs = terms(query);
  if (qs.length === 0) return [];
  return loadDocs(root)
    .map((doc) => {
      const body = doc.body.toLowerCase();
      const title = doc.title.toLowerCase();
      let score = 0;
      let first = -1;
      for (const t of qs) {
        const idx = body.indexOf(t);
        if (idx >= 0) {
          score += body.split(t).length - 1;
          if (first < 0 || idx < first) first = idx;
        }
        if (title.includes(t)) score += 3;
      }
      const start = Math.max(0, first - SNIPPET_RADIUS);
      const snippet = first >= 0 ? doc.body.slice(start, first + SNIPPET_RADIUS).replace(/\s+/g, " ").trim() : "";
      return { doc, score, snippet };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);
}
