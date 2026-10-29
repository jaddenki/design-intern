// AGENT_RUNNER=modal: each agent turn runs in a fresh Modal Sandbox with no public
// egress. Its only way out is an Agent Proxy sidecar that injects credentials, so
// the sandbox holds nothing but a short-lived session token. Ported from
// Infisical/modal-agent (src/modal.ts, src/run.ts); see its docs/contract.md.
import { rmSync } from "node:fs";
import path from "node:path";
import { ModalClient, NotFoundError, type App, type Image, type Sandbox, type Secret } from "modal";
import type { Draft } from "../drafts/types.js";
import type { RunContext } from "../run-context.js";
import { acceptResult } from "./accept.js";
import { APP_DIR, appBundle, CLAUDE_BINARY, SANDBOX_USER, sandboxImage } from "./image.js";
import { parseEventLine, sandboxEnv, type Job, type SandboxEvent } from "./job.js";
import { createVault } from "./vault.js";

const PROXY_SIDECAR = "agent-proxy";
const PROXY_PORT = 17323;
const SESSION_MARGIN_MS = 5 * 60_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;

// The proxy token reaches only the sidecar, as INFISICAL_AGENT_VAULT_PROXY_TOKEN from
// a Modal Secret. Each start loads the proxy's settings and CA from Infisical.
const PROXY_COMMAND = `mkdir -p /tmp/proxy && exec infisical agent-vault proxy --data-dir /tmp/proxy --port ${PROXY_PORT} --telemetry=false >/tmp/proxy.log 2>&1`;

const WAIT_FOR_PROXY = `node -e '
const deadline = Date.now() + 30000;
(async () => {
  for (;;) {
    const ok = await fetch("http://127.0.0.1:${PROXY_PORT}/_agent-vault/ca", { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (ok) process.exit(0);
    if (Date.now() > deadline) process.exit(1);
    await new Promise((r) => setTimeout(r, 100));
  }
})();' || { tail -n 5 /tmp/proxy.log; exit 1; }`;

const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

export interface ModalConfig {
  appName: string;
  environment?: string;
  bundle: string;
  proxySecret: string;
  caFingerprint: string;
  infisicalDomain: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}

export function modalConfig(env: NodeJS.ProcessEnv = process.env): ModalConfig {
  const get = (k: string) => env[k]?.trim() || undefined;
  const required = [
    "AGENT_VAULT_CA_FINGERPRINT",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
  ];
  const missing = required.filter((k) => !get(k));
  if (missing.length > 0) throw new Error(`AGENT_RUNNER=modal needs ${missing.join(", ")}.`);
  return {
    appName: get("MODAL_APP_NAME") ?? "design-intern",
    environment: get("MODAL_ENVIRONMENT"),
    bundle: get("AGENT_VAULT_ACCESS_BUNDLE") ?? "design-intern",
    proxySecret: get("AGENT_VAULT_PROXY_SECRET") ?? "design-intern-proxy",
    caFingerprint: get("AGENT_VAULT_CA_FINGERPRINT")!,
    infisicalDomain: get("INFISICAL_DOMAIN") ?? "https://app.infisical.com",
    clientId: get("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID")!,
    clientSecret: get("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET")!,
    timeoutMs: Number(get("RUN_TIMEOUT_MS") ?? 15 * 60_000),
  };
}

/**
 * Runs as `user` in the agent container. The token is the first stdin line, so it
 * never shows up in the argv Modal records; the job JSON is the rest of stdin.
 * The CLI's own telemetry and update checks are pointed at a closed port so they
 * fail fast instead of waiting out DNS (modal-agent's CLI_OFFLINE_ENV).
 */
export function bootstrapScript(caFingerprint: string): string {
  return [
    "set -eu",
    "IFS= read -r INFISICAL_AGENT_VAULT_SESSION_TOKEN",
    "export INFISICAL_AGENT_VAULT_SESSION_TOKEN",
    `export INFISICAL_AGENT_VAULT_PROXY_ADDRESS=${PROXY_SIDECAR}:${PROXY_PORT} NODE_USE_ENV_PROXY=1`,
    `cd ${APP_DIR}`,
    "exec env HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 INFISICAL_DISABLE_UPDATE_CHECK=1 " +
      `infisical agent-vault run --telemetry=false --ca-fingerprint=${quote(caFingerprint)} -- node dist/sandbox/entry.js`,
  ].join("\n");
}

interface Modal {
  client: ModalClient;
  app: App;
  image: Image;
  proxySecret: Secret;
  vault: ReturnType<typeof createVault>;
}

let ready: Promise<Modal> | undefined;

function connect(cfg: ModalConfig): Promise<Modal> {
  ready ??= (async () => {
    const client = new ModalClient({
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
      environment: cfg.environment,
    });
    const app = await client.apps.fromName(cfg.appName, { createIfMissing: true });
    const [image, proxySecret] = await Promise.all([
      sandboxImage(client).build(app),
      client.secrets.fromName(cfg.proxySecret, { requiredKeys: ["INFISICAL_AGENT_VAULT_PROXY_TOKEN"] }),
    ]);
    const vault = createVault({ domain: cfg.infisicalDomain, clientId: cfg.clientId, clientSecret: cfg.clientSecret });
    return { client, app, image, proxySecret, vault };
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

async function rootExec(sandbox: Sandbox, script: string, what: string): Promise<void> {
  const proc = await sandbox.exec(["sh", "-c", script], { mode: "text", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
  if (code !== 0) throw new Error(`${what} failed: ${(err || out).trim().slice(-500) || `exit ${code}`}`);
}

async function startProxy(sandbox: Sandbox, image: Image, proxySecret: Secret): Promise<void> {
  const sidecar = await sandbox.experimentalSidecars.create(PROXY_SIDECAR, image, {
    command: ["sh", "-c", PROXY_COMMAND],
    secrets: [proxySecret],
  });
  const wait = await sidecar.exec(["sh", "-c", WAIT_FOR_PROXY], { mode: "text", stdout: "pipe", stderr: "pipe" });
  const [log, code] = await Promise.all([wait.stdout.readText(), wait.wait()]);
  if (code !== 0) throw new Error(`Agent Proxy didn't start in the sidecar: ${log.trim() || `exit ${code}`}`);
}

async function* lines(stream: AsyncIterable<string>): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

export async function runInSandbox(
  prompt: string,
  ctx: RunContext,
  draft: Draft | undefined,
  model: string,
  onProgress?: (message: string) => void,
): Promise<string> {
  const cfg = modalConfig();
  onProgress?.(`:brain: Using ${model}`);
  onProgress?.(":package: Checking the sandbox image…");
  const { client, app, image, proxySecret, vault } = await connect(cfg);
  onProgress?.(":lock: Starting a sandbox and an Agent Vault session…");
  const job: Job = {
    prompt,
    mode: ctx.mode,
    actor: ctx.actor,
    runId: ctx.runId,
    model,
    draft,
    seed: [...ctx.sources.values()],
    env: { ...sandboxEnv(), DATA_DIR: "/tmp/design-intern-data", CLAUDE_CODE_EXECUTABLE: CLAUDE_BINARY },
  };
  const ttl = `${Math.ceil((cfg.timeoutMs + SESSION_MARGIN_MS) / 60_000)}m`;
  const bundleFile = appBundle();
  let session: { id: string; token: string } | undefined;
  let sandbox: Sandbox | undefined;

  try {
    // Minted while the sandbox boots; both are cleaned up in finally.
    const [s, sb] = await Promise.allSettled([
      vault.createSession(cfg.bundle, ttl),
      client.sandboxes.create(app, image, {
        timeoutMs: cfg.timeoutMs,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        cpu: 1,
        memoryMiB: 2048,
        tags: { app: "design-intern", mode: ctx.mode, model },
        outboundCidrAllowlist: [],
      }),
    ]);
    if (s.status === "fulfilled") session = s.value;
    if (sb.status === "fulfilled") sandbox = sb.value;
    if (s.status === "rejected") throw s.reason;
    if (sb.status === "rejected") throw sb.reason;

    onProgress?.(":shield: Sandbox up; starting Agent Proxy…");
    await sandbox!.filesystem.copyFromLocal(bundleFile, "/tmp/app.tgz");
    await rootExec(sandbox!, `tar -xzf /tmp/app.tgz -C ${APP_DIR} && rm /tmp/app.tgz`, "Installing the app");
    await startProxy(sandbox!, image, proxySecret);

    onProgress?.(":robot_face: Agent started…");
    const proc = await sandbox!.exec(["runuser", "-u", SANDBOX_USER, "--", "sh", "-c", bootstrapScript(cfg.caFingerprint)], {
      mode: "text",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.stdin.writeText(`${session!.token}\n${JSON.stringify(job)}`);
    await proc.stdin.close();

    let stderr = "";
    const drainErr = (async () => {
      for await (const chunk of proc.stderr) stderr = (stderr + chunk).slice(-2000);
    })();
    let result: Extract<SandboxEvent, { type: "result" }> | undefined;
    let failure: string | undefined;
    for await (const line of lines(proc.stdout)) {
      const event = parseEventLine(line);
      if (event?.type === "progress" && typeof event.label === "string") onProgress?.(event.label.slice(0, 200));
      else if (event?.type === "result") result = event;
      else if (event?.type === "error") failure = String(event.message).slice(0, 500);
    }
    const [code] = await Promise.all([proc.wait(), drainErr]);

    if (failure) throw new Error(`Agent failed in the sandbox: ${failure}`);
    if (!result) throw new Error(`Sandbox exited ${code} without a result. ${stderr.trim().slice(-500)}`.trim());
    acceptResult(result, ctx, draft);
    return typeof result.text === "string" ? result.text : "";
  } finally {
    rmSync(path.dirname(bundleFile), { recursive: true, force: true });
    // Revoke first, so a sandbox that outlives terminate can't use the session.
    if (session) await vault.revokeSession(session.id).catch((err) => console.error(`Session revoke failed: ${err}`));
    if (sandbox) {
      await sandbox.terminate({ wait: true }).catch((err) => {
        if (!(err instanceof NotFoundError)) console.error(`Sandbox terminate failed: ${err}`);
      });
    }
  }
}
