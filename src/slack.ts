import "dotenv/config";
import http from "node:http";
import { App } from "@slack/bolt";
import { HttpsProxyAgent } from "https-proxy-agent";
import { runAgent } from "./run-agent.js";

// @slack/web-api hard-codes `proxy: false` on its axios client, ignoring
// HTTPS_PROXY env vars. Pass an explicit agent so the agent-vault MITM proxy
// can intercept and substitute placeholder tokens.
const proxyUrl = process.env.HTTPS_PROXY;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  clientOptions: { agent },
});

let botUserId: string | undefined;

const stripBotMention = (text: string) =>
  botUserId ? text.replaceAll(`<@${botUserId}>`, "").trim() : text.trim();

async function handleMessage(
  text: string,
  channel: string,
  threadTs: string,
  isThreadReply: boolean,
  client: InstanceType<typeof App>["client"],
) {
  const userMessage = stripBotMention(text);

  if (!userMessage) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Hey! How can I help?",
    });
    return;
  }

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

  const transcript = (history?.messages ?? [])
    .filter((m) => Boolean(m.text))
    .map((m) => {
      const isBot = (botUserId && m.user === botUserId) || Boolean(m.bot_id);
      const cleanText = stripBotMention(m.text ?? "");
      // TODO: replace "Agent" with your bot's display name for nicer transcripts.
      return isBot ? `Agent: ${cleanText}` : `<@${m.user}>: ${cleanText}`;
    })
    .join("\n");

  // Always append userMessage explicitly: conversations.replies returns the
  // oldest N messages, so on a long thread the triggering message itself can
  // fall outside the window. Slight redundancy in the common case is fine.
  const prompt = transcript
    ? `Conversation in this Slack thread so far:\n\n${transcript}\n\nRespond to this latest message: ${userMessage}`
    : userMessage;

  try {
    let lastProgress = "";
    const response = await runAgent(prompt, (progress) => {
      if (progress === lastProgress) return;
      lastProgress = progress;
      client.chat.update({ channel, ts: thinkingTs, text: progress }).catch(() => {});
    });

    await client.chat.update({
      channel,
      ts: thinkingTs,
      text: response || "I couldn't find an answer. Try rephrasing your question.",
    });
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
  await handleMessage(event.text, event.channel, threadTs, event.thread_ts !== undefined, client);
});

// Handle direct messages
app.event("message", async ({ event, client }) => {
  if (event.channel_type !== "im") return;
  if (event.subtype) return;
  const eventThreadTs = (event as { thread_ts?: string }).thread_ts;
  const threadTs = eventThreadTs ?? event.ts;
  await handleMessage(event.text ?? "", event.channel, threadTs, eventThreadTs !== undefined, client);
});

const port = Number(process.env.PORT) || 3000;
http
  .createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?", 1)[0].replace(/\/+$/, "") || "/";
    if (pathname === "/" || pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(port, () => {
    console.log(`HTTP server listening on :${port}`);
  });

(async () => {
  const auth = await app.client.auth.test();
  botUserId = auth.user_id;
  await app.start();
  console.log("Agent is running in Socket Mode");
})();
