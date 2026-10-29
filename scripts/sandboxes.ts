// `make sandboxes`: Design Intern's running Modal Sandboxes, one per agent turn.
import { ModalClient } from "modal";

const modal = new ModalClient({
  tokenId: process.env.MODAL_TOKEN_ID,
  tokenSecret: process.env.MODAL_TOKEN_SECRET,
  environment: process.env.MODAL_ENVIRONMENT?.trim() || undefined,
});
const app = await modal.apps.fromName(process.env.MODAL_APP_NAME?.trim() || "design-intern", { createIfMissing: true });

const rows: string[] = [];
for await (const sb of modal.sandboxes.list({ appId: app.appId, tags: { app: "design-intern" } })) {
  const [tags, sidecars] = await Promise.all([sb.getTags(), sb.experimentalSidecars.list().catch(() => [])]);
  rows.push(`${sb.sandboxId}  ${(tags.mode ?? "?").padEnd(5)}  ${(tags.model ?? "?").padEnd(18)}  sidecars: ${sidecars.map((c) => c.containerName).join(", ") || "none"}`);
}
console.log(rows.length ? `${rows.length} running sandbox(es) in ${app.appId}:\n${rows.join("\n")}` : "No running sandboxes.");
