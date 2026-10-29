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
    async createSession(bundle: string, ttl: string): Promise<{ id: string; token: string }> {
      const { session } = await request<{ session: { id: string; token: string } }>(
        "POST",
        "/api/v1/agent-vault/sessions",
        { accessBundles: [bundle], ttl },
        await accessToken(),
      );
      return { id: session.id, token: session.token };
    },
    async revokeSession(id: string): Promise<void> {
      await request("POST", `/api/v1/agent-vault/sessions/${encodeURIComponent(id)}/revoke`, undefined, await accessToken());
    },
  };
}
