// Figma REST calls from inside the sandbox. FIGMA_API_KEY is a placeholder there;
// the Agent Vault proxy swaps in the real token on the wire.
const API_BASE = "https://api.figma.com";
const REQUEST_TIMEOUT_MS = 30_000;

export async function figmaGet<T>(path: string, version: "v1" | "v2" = "v1"): Promise<T> {
  const token = process.env.FIGMA_API_KEY;
  if (!token) throw new Error("Missing FIGMA_API_KEY");
  const res = await fetch(`${API_BASE}/${version}${path}`, {
    headers: { "X-Figma-Token": token },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Figma API ${res.status} ${res.statusText} for ${path.split("?")[0]}. ${body.slice(0, 300)}`.trim());
  }
  return (await res.json()) as T;
}

/** Figma node ids look like "12:34" or, inside instances, "I12:34;56:78". */
export const NODE_ID = /^I?\d+[:-]\d+(;\d+[:-]\d+)*$/;
export const normalizeNodeId = (id: string) => id.trim().replace(/-/g, ":");

/** Render URLs come from Figma's own image bucket; nothing else may be shown as a frame. */
export const FIGMA_IMAGE_URL = /^https:\/\/(figma-alpha-api\.s3\.us-west-2\.amazonaws\.com|[a-z0-9-]+\.figma\.com)\/[^\s<>|]+$/;

export const fileUrl = (fileKey: string, nodeId?: string) =>
  `https://www.figma.com/design/${encodeURIComponent(fileKey)}${nodeId ? `?node-id=${encodeURIComponent(nodeId.replace(/:/g, "-"))}` : ""}`;
