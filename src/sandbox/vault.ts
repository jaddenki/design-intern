// Agent Vault sessions, minted per run by a machine identity that is a plain
// member granted only this bundle (an admin could mint over any bundle).
// Shapes match Infisical/modal-agent's src/vault.ts, verified live there.
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const TIMEOUT_MS = 30_000;

export interface VaultConfig {
  domain: string;
  clientId: string;
  clientSecret: string;
}

/** Agent Vault labels: up to 128 characters, no line breaks, tabs, or invisible characters. */
export function sessionLabel(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 128);
}

const MAX_TASK_CHARS = 80;
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "slack:jadden@infisical.com" → "jadden"; "web:Jadden" → "Jadden". */
export function askerName(actor: string): string {
  return actor.replace(/^\w+:/, "").replace(/@.*$/, "") || actor;
}

/**
 * The label leads with what the session was for, since that's what the Sessions
 * column shows; the run id at the end matches runs.jsonl and stays searchable.
 */
export function describeRun(run: {
  mode: "draft" | "chat";
  actor: string;
  runId: string;
  question?: string;
  draftWindow?: { since: string; until: string };
  secretLike?: (s: string) => boolean;
}): string {
  const range = run.draftWindow ? `${fmtDay(run.draftWindow.since)} – ${fmtDay(run.draftWindow.until)}` : undefined;
  const q = sessionLabel(run.question ?? "");
  const said = q && !run.secretLike?.(q) ? q.charAt(0).toUpperCase() + q.slice(1) : "";
  const clip = (s: string) => (s.length > MAX_TASK_CHARS ? `${s.slice(0, MAX_TASK_CHARS - 1).trimEnd()}…` : s);
  const task =
    run.mode === "draft"
      ? "Weekly design update draft"
      : range
        ? clip(`Revise ${range} draft${said ? `: ${said}` : ""}`)
        : clip(said || "Chat question");
  return sessionLabel(`${task} · ${askerName(run.actor)} · ${run.runId.slice(0, 8)}`);
}

export function createVault({ domain, clientId, clientSecret }: VaultConfig) {
  const base = domain.replace(/\/+$/, "");
  let cached: { token: string; expiresAt: number } | undefined;

  // Errors carry status and body only, never request headers.
  async function request<T>(method: string, path: string, body?: unknown, auth?: string): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { "content-type": "application/json" }),
        ...(auth && { authorization: `Bearer ${auth}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Infisical ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`.trim());
    }
    return (await res.json()) as T;
  }

  async function accessToken(): Promise<string> {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const { accessToken, expiresIn } = await request<{ accessToken: string; expiresIn: number }>(
      "POST",
      "/api/v1/auth/universal-auth/login",
      { clientId, clientSecret },
    );
    cached = { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS };
    return accessToken;
  }

  return {
    /** `label` shows in Agent Vault's Sessions list (searchable), up to 128 characters. */
    async createSession(bundle: string, ttl: string, label?: string): Promise<{ id: string; token: string }> {
      const { session } = await request<{ session: { id: string; token: string } }>(
        "POST",
        "/api/v1/agent-vault/sessions",
        { accessBundles: [bundle], ttl, ...(label && { label: sessionLabel(label) }) },
        await accessToken(),
      );
      return { id: session.id, token: session.token };
    },
    async revokeSession(id: string): Promise<void> {
      await request("POST", `/api/v1/agent-vault/sessions/${encodeURIComponent(id)}/revoke`, undefined, await accessToken());
    },
  };
}
