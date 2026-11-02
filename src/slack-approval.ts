// Slack side of the approval gate. The agent has no Slack-write tool; the only code
// that posts an update is postApprovedUpdate, called after a human approves.
import type { KnownBlock } from "@slack/web-api";
import { USE_FIXTURES } from "./config.js";
import { draftTitle, finalMessage } from "./drafts/render.js";
import type { Draft } from "./drafts/types.js";
import { fileUrl } from "./figma/api.js";
import { containsSecret } from "./secret-guard.js";
import { isSlackConfigured, slackClient, slackErrorCode } from "./slack-client.js";

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

/** Rendered Figma frames, each with a link back to the frame. */
export function frameBlocks(draft: Pick<Draft, "previews">): KnownBlock[] {
  return (draft.previews ?? []).flatMap((p): KnownBlock[] => [
    { type: "image", image_url: p.url, alt_text: p.name, title: { type: "plain_text", text: (p.caption ?? p.name).slice(0, 150) } },
    { type: "context", elements: [{ type: "mrkdwn", text: `:art: <${fileUrl(p.fileKey, p.nodeId)}|${p.name.replace(/[<>|&]/g, "")}> in Figma` }] },
  ]);
}

export function previewBlocks(draft: Draft, { images = true } = {}): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: `Draft for review · ${draftTitle(draft).replace("Design update · ", "")}` } },
    { type: "section", text: { type: "mrkdwn", text: clip(finalMessage(draft)) } },
    ...(images ? frameBlocks(draft) : []),
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

/**
 * Slack rejects the whole message when it can't fetch an image (Figma render URLs
 * expire), so a failed send is retried without the frames rather than lost.
 */
async function withFrameFallback<T>(draft: Draft, send: (blocks: KnownBlock[]) => Promise<T>): Promise<T> {
  if (!draft.previews?.length) return send(previewBlocks(draft));
  try {
    return await send(previewBlocks(draft));
  } catch (err) {
    if (slackErrorCode(err) !== "invalid_blocks") throw err;
    console.warn(`Slack couldn't show draft ${draft.id}'s Figma frames; sending without them.`);
    return send(previewBlocks(draft, { images: false }));
  }
}

/** Post the pending draft to the approver channel. No-op when Slack isn't set up. */
export async function sendForApproval(draft: Draft): Promise<Draft["preview"]> {
  const channel = approvalChannel();
  if (!liveSlack() || !channel) return undefined;
  const res = await withFrameFallback(draft, (blocks) =>
    slackClient().chat.postMessage({ channel, text: `${draftTitle(draft)} is ready for review`, blocks }),
  );
  return res.ts ? { channel, ts: res.ts } : undefined;
}

export async function refreshPreview(draft: Draft): Promise<void> {
  if (!liveSlack() || !draft.preview) return;
  const { channel, ts } = draft.preview;
  await withFrameFallback(draft, (blocks) => slackClient().chat.update({ channel, ts, text: draftTitle(draft), blocks })).catch((err) =>
    console.error("Failed to refresh approval preview:", err),
  );
}

/** The approved message as sections (Slack caps each at 3,000 chars), then its frames. */
export function approvedBlocks(draft: Draft, body: string, { images = true } = {}): KnownBlock[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of body.split("\n")) {
    if (current && current.length + line.length + 1 > SECTION_TEXT_LIMIT) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line.slice(0, SECTION_TEXT_LIMIT);
  }
  if (current) chunks.push(current);
  return [...chunks.map((text): KnownBlock => ({ type: "section", text: { type: "mrkdwn", text } })), ...(images ? frameBlocks(draft) : [])];
}

/** Post an approved draft. Dry-runs during the eval or when no update channel is set. */
export async function postApprovedUpdate(draft: Draft): Promise<NonNullable<Draft["posted"]>> {
  if (draft.status !== "approved") throw new Error(`Refusing to post draft ${draft.id}: status is ${draft.status}.`);
  const body = finalMessage(draft);
  if (containsSecret(body)) throw new Error(`Refusing to post draft ${draft.id}: it contains a credential-like string.`);
  const channel = updateChannel();
  if (!liveSlack() || !channel) return { channel: channel ?? "(not configured)", dryRun: true };
  const send = (images: boolean) =>
    slackClient().chat.postMessage({
      channel,
      text: body,
      unfurl_links: false,
      unfurl_media: false,
      ...(draft.previews?.length && { blocks: approvedBlocks(draft, body, { images }) }),
    });
  const res = await send(true).catch((err) => {
    if (!draft.previews?.length || slackErrorCode(err) !== "invalid_blocks") throw err;
    console.warn(`Slack couldn't show draft ${draft.id}'s Figma frames; posting without them.`);
    return send(false);
  });
  return { channel, ts: res.ts, dryRun: false };
}
