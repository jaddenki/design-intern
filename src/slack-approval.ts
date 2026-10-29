// Slack side of the approval gate. The agent has no Slack-write tool; the only code
// that posts an update is postApprovedUpdate, called after a human approves.
import type { KnownBlock } from "@slack/web-api";
import { USE_FIXTURES } from "./config.js";
import { draftTitle, finalMessage } from "./drafts/render.js";
import type { Draft } from "./drafts/types.js";
import { containsSecret } from "./secret-guard.js";
import { isSlackConfigured, slackClient } from "./slack-client.js";

const SECTION_TEXT_LIMIT = 2_900;

export const APPROVE_ACTION = "approve_draft";
export const REJECT_ACTION = "reject_draft";
export const EDIT_ACTION = "edit_message";
export const EDIT_VIEW = "edit_message_view";
/** Slack's limit for a plain_text_input; longer messages are edited in the inbox. */
export const EDIT_MAX_CHARS = 3_000;

const approvalChannel = () => process.env.DESIGN_APPROVAL_CHANNEL?.trim();
const updateChannel = () => process.env.DESIGN_UPDATE_CHANNEL?.trim();
const liveSlack = () => !USE_FIXTURES && isSlackConfigured();

export function inboxUrl(draftId?: string): string | undefined {
  const base = process.env.WEB_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) return undefined;
  return draftId ? `${base}/#${draftId}` : base;
}

function clip(s: string): string {
  return s.length > SECTION_TEXT_LIMIT ? `${s.slice(0, SECTION_TEXT_LIMIT)}…\n_(truncated, open the inbox for the full draft)_` : s;
}

export function previewBlocks(draft: Draft): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: `Draft for review · ${draftTitle(draft).replace("Design update · ", "")}` } },
    { type: "section", text: { type: "mrkdwn", text: clip(finalMessage(draft)) } },
  ];
  if (draft.notes.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: clip(`*Notes for you:*\n${draft.notes.map((n) => `• ${n}`).join("\n")}`) }],
    });
  }
  if (draft.status === "pending") {
    const url = inboxUrl(draft.id);
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", style: "primary", action_id: APPROVE_ACTION, value: draft.id, text: { type: "plain_text", text: "Approve & post" } },
        { type: "button", action_id: EDIT_ACTION, value: draft.id, text: { type: "plain_text", text: "Edit message" } },
        { type: "button", style: "danger", action_id: REJECT_ACTION, value: draft.id, text: { type: "plain_text", text: "Reject" } },
        ...(url ? [{ type: "button" as const, action_id: "open_inbox", url, text: { type: "plain_text" as const, text: "Open in inbox" } }] : []),
      ],
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "*Edit message* to change the wording yourself, or reply in this thread and @mention me to ask why something's in or out or to request changes.",
        },
      ],
    });
  } else {
    const last = [...draft.history].reverse().find((e) => e.action === "approved" || e.action === "rejected");
    const verb = draft.status === "approved" ? ":white_check_mark: Approved" : ":x: Rejected";
    const where = draft.posted && !draft.posted.dryRun ? ` and posted to <#${draft.posted.channel}>` : "";
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${verb} by ${last?.by ?? "someone"}${where}.` }] });
  }
  return blocks;
}

/** Post the pending draft to the approver channel. No-op when Slack isn't set up. */
export async function sendForApproval(draft: Draft): Promise<Draft["preview"]> {
  const channel = approvalChannel();
  if (!liveSlack() || !channel) return undefined;
  const res = await slackClient().chat.postMessage({ channel, text: `${draftTitle(draft)} is ready for review`, blocks: previewBlocks(draft) });
  return res.ts ? { channel, ts: res.ts } : undefined;
}

export async function refreshPreview(draft: Draft): Promise<void> {
  if (!liveSlack() || !draft.preview) return;
  await slackClient()
    .chat.update({ channel: draft.preview.channel, ts: draft.preview.ts, text: draftTitle(draft), blocks: previewBlocks(draft) })
    .catch((err) => console.error("Failed to refresh approval preview:", err));
}

/** Post an approved draft. Dry-runs during the eval or when no update channel is set. */
export async function postApprovedUpdate(draft: Draft): Promise<NonNullable<Draft["posted"]>> {
  if (draft.status !== "approved") throw new Error(`Refusing to post draft ${draft.id}: status is ${draft.status}.`);
  const body = finalMessage(draft);
  if (containsSecret(body)) throw new Error(`Refusing to post draft ${draft.id}: it contains a credential-like string.`);
  const channel = updateChannel();
  if (!liveSlack() || !channel) return { channel: channel ?? "(not configured)", dryRun: true };
  const res = await slackClient().chat.postMessage({ channel, text: body, unfurl_links: false, unfurl_media: false });
  return { channel, ts: res.ts, dryRun: false };
}
