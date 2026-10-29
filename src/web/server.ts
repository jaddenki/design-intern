// HTTP surface: Render's /health check plus the approval inbox and its JSON API.
// The inbox is off unless WEB_ACCESS_PASSWORD is set; every inbox route then needs
// HTTP Basic auth (any username, used as the actor name in draft history).
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { AGENT_NAME, APP_ROOT } from "../config.js";
import { approveDraft, editDraft, editMessage, generateDraft, isGenerating, rejectDraft, type LineEdit } from "../drafts/actions.js";
import { finalMessage, renderDraftMrkdwn } from "../drafts/render.js";
import type { Draft } from "../drafts/types.js";
import { getDraft, listDrafts } from "../drafts/store.js";
import { runAgent } from "../run-agent.js";

const WEB_DIR = path.join(APP_ROOT, "web");
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HISTORY_TURNS = 20;

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/avatar.png": { file: "avatar.png", type: "image/png" },
};

const password = () => process.env.WEB_ACCESS_PASSWORD ?? "";

export function inboxEnabled(): boolean {
  return password().length > 0;
}

/** Returns the Basic-auth username when the password matches, else undefined. */
export function authenticate(header: string | undefined, expected = password()): string | undefined {
  if (!expected || !header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return undefined;
  const user = decoded.slice(0, sep).trim();
  const given = Buffer.from(decoded.slice(sep + 1));
  const want = Buffer.from(expected);
  if (!user || given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
  return user.slice(0, 60);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Send application/json.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Newline-delimited JSON stream so the UI can show tool progress live. */
function stream(res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  return (event: Record<string, unknown>) => res.write(`${JSON.stringify(event)}\n`);
}

function summary(d: ReturnType<typeof listDrafts>[number]) {
  return { id: d.id, status: d.status, createdAt: d.createdAt, updatedAt: d.updatedAt, window: d.window, lineCount: d.lines.length };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, user: string) {
  const actor = `web:${user}`;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/api/state") {
    return json(res, 200, { agentName: AGENT_NAME, user, generating: isGenerating(), drafts: listDrafts().map(summary) });
  }

  if (method === "POST" && pathname === "/api/drafts/generate") {
    const body = await readJson(req);
    const checkIn = typeof body.checkIn === "string" ? body.checkIn : undefined;
    const send = stream(res);
    try {
      const { draft, summary: text } = await generateDraft(actor, (m) => send({ type: "progress", text: m }), checkIn);
      send({ type: "result", text, draftId: draft.id });
    } catch (err) {
      console.error("Web generate failed:", err);
      send({ type: "error", text: err instanceof Error ? err.message : "Generation failed." });
    }
    return res.end();
  }

  if (method === "POST" && pathname === "/api/chat") {
    const body = await readJson(req);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw new HttpError(400, "message is required.");
    const draftId = typeof body.draftId === "string" ? body.draftId : undefined;
    const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_TURNS) : [];
    const transcript = history
      .filter((t): t is { role: string; text: string } => typeof t?.text === "string" && typeof t?.role === "string")
      .map((t) => `${t.role === "agent" ? AGENT_NAME : user}: ${t.text}`)
      .join("\n");
    const prompt = transcript ? `Conversation so far:\n\n${transcript}\n\nRespond to this latest message: ${message}` : message;
    const before = draftId ? getDraft(draftId)?.updatedAt : undefined;
    const send = stream(res);
    try {
      const { text } = await runAgent(prompt, { mode: "chat", actor, draftId, onProgress: (m) => send({ type: "progress", text: m }) });
      const after = draftId ? getDraft(draftId)?.updatedAt : undefined;
      send({ type: "result", text: text || "I couldn't find an answer.", draftChanged: before !== after });
    } catch (err) {
      console.error("Web chat failed:", err);
      send({ type: "error", text: "Sorry, I ran into an error. Please try again." });
    }
    return res.end();
  }

  // The inbox shows the exact Slack message next to the template's version.
  const view = (draft: Draft) => ({ ...draft, rendered: finalMessage(draft), generated: renderDraftMrkdwn(draft) });

  const match = pathname.match(/^\/api\/drafts\/([a-z0-9_]+)(?:\/(approve|reject))?$/);
  if (!match) throw new HttpError(404, "Not found.");
  const [, id, action] = match;

  if (method === "GET" && !action) {
    const draft = getDraft(id);
    return draft ? json(res, 200, view(draft)) : json(res, 404, { error: "Draft not found." });
  }
  if (method === "PATCH" && !action) {
    const body = await readJson(req);
    if ("message" in body) {
      const message = typeof body.message === "string" ? body.message : null;
      return json(res, 200, view(await editMessage(id, actor, message)));
    }
    const edits = Array.isArray(body.edits) ? (body.edits as LineEdit[]) : [];
    return json(res, 200, view(await editDraft(id, actor, edits)));
  }
  if (method === "POST" && action === "approve") {
    await readJson(req);
    return json(res, 200, view(await approveDraft(id, actor)));
  }
  if (method === "POST" && action === "reject") {
    const body = await readJson(req);
    return json(res, 200, view(await rejectDraft(id, actor, typeof body.reason === "string" ? body.reason : undefined)));
  }
  throw new HttpError(405, "Method not allowed.");
}

export function startWebServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const pathname = (req.url ?? "/").split("?", 1)[0].replace(/\/+$/, "") || "/";
    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (!inboxEnabled()) {
      res.writeHead(pathname === "/" ? 200 : 404, { "content-type": "text/plain" });
      res.end(pathname === "/" ? "ok" : "");
      return;
    }
    const user = authenticate(req.headers.authorization);
    if (!user) {
      res.writeHead(401, { "www-authenticate": `Basic realm="${AGENT_NAME} inbox", charset="UTF-8"` });
      res.end("Sign in with your name and the inbox password.");
      return;
    }
    try {
      if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname, user);
      const asset = STATIC[pathname];
      if (!asset || req.method !== "GET") throw new HttpError(404, "Not found.");
      const body = await readFile(path.join(WEB_DIR, asset.file));
      res.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      const message = err instanceof Error ? err.message : "Server error.";
      // Action errors (already approved, missing line) are user-facing.
      return json(res, /not found|already|isn't in|can't|Unknown section|credential/.test(message) ? 409 : 500, { error: message });
    }
  });
  server.listen(port, () => {
    console.log(`HTTP server listening on :${port}${inboxEnabled() ? " (inbox enabled)" : ""}`);
  });
  return server;
}
