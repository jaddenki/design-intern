// One Slack WebClient for every non-Bolt caller (source reads, draft posting).
// @slack/web-api hard-codes `proxy: false`, so pass the agent-vault proxy explicitly.
// Never pass a per-call `token`: it goes in the form body, which the proxy can't rewrite.
import { WebClient } from "@slack/web-api";
import { HttpsProxyAgent } from "https-proxy-agent";

const proxyUrl = process.env.HTTPS_PROXY;
export const slackAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

let client: WebClient | undefined;

export function slackClient(): WebClient {
  client ??= new WebClient(process.env.SLACK_BOT_TOKEN, { agent: slackAgent });
  return client;
}

export function isSlackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN);
}

export function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } })?.data?.error;
}

/** Slack refused because the bot can't see that channel; retrying won't help. */
export function isNotInChannel(err: unknown): boolean {
  const code = slackErrorCode(err);
  return code === "channel_not_found" || code === "not_in_channel" || code === "is_archived";
}
