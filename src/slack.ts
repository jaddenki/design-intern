import "./bootstrap.js";
import { App } from "@slack/bolt";
import { allowlistConfigured, DESIGN_TEAM_ONLY_MESSAGE, isAllowedEmail } from "./access.js";
import { AGENT_NAME } from "./config.js";
import { approveDraft, generateDraft, rejectDraft } from "./drafts/actions.js";
import { finalMessage } from "./drafts/render.js";
import { findDraftByPreview } from "./drafts/store.js";
import { DRAFT_REQUEST } from "./slack-draft-request.js";
import { splitForSlack } from "./slack-chunks.js";
import { runAgent } from "./run-agent.js";
import { startWeeklyFromEnv } from "./schedule.js";
import { APPROVE_ACTION, REJECT_ACTION } from "./slack-approval.js";
import { slackAgent } from "./slack-client.js";
import { startWebServer } from "./web/server.js";

// @slack/web-api hard-codes `proxy: false` on its axios client, ignoring
// HTTPS_PROXY env vars. Pass an explicit agent so the agent-vault MITM proxy
// can intercept and substitute placeholder tokens.
const missing = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"].filter((k) => !process.env[k]?.trim());
if (missing.length > 0) {
  console.error(
    `Missing ${missing.join(" and ")} in Secrets Manager (dev, /host). The bot token (xoxb-) appears under OAuth & Permissions once the app is installed in the workspace; the app token (xapp-) under Basic Information > App-Level Tokens.`,
  );
  process.exit(1);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  clientOptions: { agent: slackAgent },
});

type Client = InstanceType<typeof App>["client"];

let botUserId: string | undefined;

const stripBotMention = (text: string) =>
  botUserId ? text.replaceAll(`<@${botUserId}>`, "").trim() : text.trim();


const emailCache = new Map<string, string | undefined>();

async function emailFor(client: Client, userId: string | undefined): Promise<string | undefined> {
  if (!userId) return undefined;
  if (emailCache.has(userId)) return emailCache.get(userId);
  const res = await client.users.info({ user: userId }).catch(() => undefined);
  const email = res?.user?.profile?.email;
  emailCache.set(userId, email);
  return email;
}

async function handleMessage(
  text: string,
  userId: string | undefined,
  channel: string,
  threadTs: string,
  isThreadReply: boolean,
  client: Client,
) {
  const userMessage = stripBotMention(text);
  const email = await emailFor(client, userId);

  if (!isAllowedEmail(email)) {
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: DESIGN_TEAM_ONLY_MESSAGE });
    return;
  }

  if (!userMessage) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Hey! I'm ${AGENT_NAME}. Ask me to *draft the weekly update*, ask why something is or isn't in a draft, or ask a design reference question.`,
    });
    return;
  }

  // A thread under an approval preview is a conversation about that draft.
  const draft = isThreadReply ? findDraftByPreview(channel, threadTs) : undefined;

  // First-in-thread messages have no history to fetch, so skip the API call.
  // For replies, fetch history in parallel with posting the thinking placeholder.
  const historyPromise = isThreadReply
    ? client.conversations
        .replies({ channel, ts: threadTs, limit: 200 })
        .catch((err) => {
          console.error("Failed to fetch thread history:", err);
          return undefined;
        })
    : Promise.resolve(undefined);

  const thinkingPromise = client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "Thinking...",
  });

  const [history, thinking] = await Promise.all([historyPromise, thinkingPromise]);

  const thinkingTs = thinking.ts;
  if (!thinkingTs) {
    console.error("Failed to post thinking message");
    return;
  }

  // The first part replaces "thinking"; any overflow follows in the thread.
  const reply = async (text: string) => {
    const [first, ...rest] = splitForSlack(text);
    await client.chat.update({ channel, ts: thinkingTs, text: first });
    for (const part of rest) await client.chat.postMessage({ channel, thread_ts: threadTs, text: part });
  };

  let lastProgress = "";
  const onProgress = (progress: string) => {
    if (progress === lastProgress) return;
    lastProgress = progress;
    client.chat.update({ channel, ts: thinkingTs, text: progress }).catch(() => {});
  };
  const actor = `slack:${email}`;

  try {
    if (!draft && DRAFT_REQUEST.test(userMessage)) {
      // The whole message doubles as the check-in ("btw I also worked on…").
      const { draft: created, summary } = await generateDraft(actor, onProgress, userMessage);
      const where = created.preview
        ? `Waiting for approval in <#${created.preview.channel}>. Nothing posts until someone approves it.`
        : "Nothing posts until someone approves it in the inbox.";
      await reply(`${finalMessage(created)}\n\n———\n_${where}_\n${summary}`);
      return;
    }

    const transcript = (history?.messages ?? [])
      .filter((m) => Boolean(m.text) && m.ts !== thinkingTs)
      .map((m) => {
        const isBot = (botUserId && m.user === botUserId) || Boolean(m.bot_id);
        const cleanText = stripBotMention(m.text ?? "");
        return isBot ? `${AGENT_NAME}: ${cleanText}` : `<@${m.user}>: ${cleanText}`;
      })
      .join("\n");

    // Always append userMessage explicitly: conversations.replies returns the
    // oldest N messages, so on a long thread the triggering message itself can
    // fall outside the window. Slight redundancy in the common case is fine.
    const prompt = transcript
      ? `Conversation in this Slack thread so far:\n\n${transcript}\n\nRespond to this latest message: ${userMessage}`
      : userMessage;

    const { text: response } = await runAgent(prompt, { mode: "chat", actor, draftId: draft?.id, question: userMessage, onProgress });

    await reply(response || "I couldn't find an answer. Try rephrasing your question.");
  } catch (error) {
    console.error("Agent error:", error);
    try {
      await client.chat.update({
        channel,
        ts: thinkingTs,
        text: ":warning: Sorry, I ran into an error. Please try again.",
      });
    } catch (updateError) {
      console.error("Failed to update error message:", updateError);
    }
  }
}

// Handle @mentions in channels
app.event("app_mention", async ({ event, client }) => {
  const threadTs = event.thread_ts ?? event.ts;
  await handleMessage(event.text, event.user, event.channel, threadTs, event.thread_ts !== undefined, client);
});

// Handle direct messages
app.event("message", async ({ event, client }) => {
  if (event.channel_type !== "im") return;
  if (event.subtype) return;
  const eventThreadTs = (event as { thread_ts?: string }).thread_ts;
  const threadTs = eventThreadTs ?? event.ts;
  await handleMessage(event.text ?? "", event.user, event.channel, threadTs, eventThreadTs !== undefined, client);
});

async function decide(
  kind: "approve" | "reject",
  body: { user: { id: string }; channel?: { id: string }; actions: unknown[] },
  client: Client,
) {
  const draftId = (body.actions[0] as { value?: string }).value ?? "";
  const email = await emailFor(client, body.user.id);
  const channel = body.channel?.id;
  const tell = (text: string) =>
    channel ? client.chat.postEphemeral({ channel, user: body.user.id, text }).catch(() => {}) : undefined;

  if (!isAllowedEmail(email)) {
    await tell(DESIGN_TEAM_ONLY_MESSAGE);
    return;
  }
  try {
    if (kind === "approve") {
      const draft = await approveDraft(draftId, `slack:${email}`);
      if (draft.posted?.dryRun) await tell("Approved. DESIGN_UPDATE_CHANNEL isn't set, so nothing was posted (dry run).");
    } else {
      await rejectDraft(draftId, `slack:${email}`);
    }
  } catch (err) {
    console.error(`Failed to ${kind} draft ${draftId}:`, err);
    await tell(`:warning: ${err instanceof Error ? err.message : "Something went wrong."}`);
  }
}

app.action(APPROVE_ACTION, async ({ ack, body, client }) => {
  await ack();
  await decide("approve", body as Parameters<typeof decide>[1], client);
});

app.action(REJECT_ACTION, async ({ ack, body, client }) => {
  await ack();
  await decide("reject", body as Parameters<typeof decide>[1], client);
});

// URL buttons still send an action that must be acked.
app.action("open_inbox", async ({ ack }) => {
  await ack();
});

startWebServer(Number(process.env.PORT) || 3000);

(async () => {
  if (!allowlistConfigured()) {
    console.warn("DESIGN_ALLOWLIST is empty: the bot will decline everyone.");
  }
  const auth = await app.client.auth.test();
  botUserId = auth.user_id;
  await app.start();
  console.log(`${AGENT_NAME} is running in Socket Mode`);
  startWeeklyFromEnv(async () => {
    await generateDraft("schedule");
  });
})();
