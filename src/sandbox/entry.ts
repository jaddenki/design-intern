// Runs inside the Modal Sandbox under `infisical agent-vault run`. Reads one job
// from stdin, runs the agent with an in-memory draft sink, prints events.
import { encodeEvent, type Job, type SandboxEvent } from "./job.js";

const emit = (event: SandboxEvent) => process.stdout.write(encodeEvent(event));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const job = JSON.parse(await readStdin()) as Job;
  Object.assign(process.env, job.env);

  // Config is read at import time, so everything else loads after the env is set.
  await import("../bootstrap.js");
  const { createRunContext } = await import("../run-context.js");
  const { memorySink } = await import("../drafts/sink.js");
  const { runInProcess } = await import("../run-agent.js");

  const drafts = memorySink(job.draft);
  const ctx = createRunContext({
    mode: job.mode,
    actor: job.actor,
    draftId: job.draft?.id,
    seed: job.draft ? Object.values(job.draft.sources) : [],
    drafts,
  });
  ctx.runId = job.runId;

  const text = await runInProcess(job.prompt, ctx, job.draft, (label) => emit({ type: "progress", label }));
  emit({ type: "result", text, sources: [...ctx.sources.values()], toolCalls: ctx.toolCalls, drafts: drafts.saved() });
}

main().catch((err) => {
  emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
