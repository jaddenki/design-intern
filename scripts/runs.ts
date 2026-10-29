// `make runs`: the last agent runs from data/runs.jsonl, with the model each used.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";

const file = path.join(DATA_DIR, "runs.jsonl");
const count = Number(process.argv[2]) || 10;
const runs = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-count) : [];
if (runs.length === 0) console.log("No runs yet.");
for (const line of runs) {
  const r = JSON.parse(line);
  const secs = ((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000).toFixed(0);
  const when = new Date(r.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const outcome = r.error ? `error: ${String(r.error).slice(0, 60)}` : r.draftId ? `draft ${r.draftId}` : "ok";
  console.log(`${when.padEnd(16)}  ${r.mode.padEnd(5)}  ${r.model.padEnd(18)}  ${`${secs}s`.padStart(5)}  ${String(r.toolCalls.length).padStart(2)} tools  ${r.actor}  ${outcome}`);
}
