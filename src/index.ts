import "./bootstrap.js";
import { generateDraft } from "./drafts/actions.js";
import { renderDraftMrkdwn } from "./drafts/render.js";
import { runAgent } from "./run-agent.js";

const prompt = process.argv[2] || "Say hello and tell me what tools you have available.";
const progress = (m: string) => console.error(`  ${m}`);

console.log(`\nPrompt: ${prompt}\n`);
try {
  if (prompt === "draft") {
    const { draft, summary } = await generateDraft("cli", progress);
    console.log(`${summary}\n\n${renderDraftMrkdwn(draft)}\n\nNotes:\n${draft.notes.map((n) => `- ${n}`).join("\n")}\n\nSaved as ${draft.id} (pending).`);
  } else {
    const { text } = await runAgent(prompt, { onProgress: progress });
    console.log(text);
  }
} catch (error) {
  console.error("Agent error:", error);
  process.exit(1);
}
