// Reads design discussion from Slack. DESIGN_SLACK_CHANNELS (channel ids) is the
// boundary: only those channels are ever requested, and every channel is re-checked
// against the list before its messages are returned.
import { envList, USE_FIXTURES } from "../config.js";
import { loadFixture } from "../fixtures.js";
import { isNotInChannel, isSlackConfigured, slackClient } from "../slack-client.js";
import type { TimeWindow } from "../run-context.js";

const MAX_MESSAGES_PER_CHANNEL = 400;
const MAX_REPLIES = 50;
const MAX_TEXT_CHARS = 2_000;
const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;

export interface RawMessage {
  ts: string;
  user?: string;
  userName?: string;
  bot_id?: string;
  subtype?: string;
  text: string;
  reply_count?: number;
  replies?: RawMessage[];
}

export interface RawChannel {
  id: string;
  name: string;
  messages: RawMessage[];
}

export interface SlackMessage {
  ts: string;
  author: string;
  text: string;
  permalink: string;
}

export interface SlackThread extends SlackMessage {
  channelId: string;
  channelName: string;
  replies: SlackMessage[];
}

export function channelIds(): string[] {
  return envList("DESIGN_SLACK_CHANNELS").filter((c) => CHANNEL_ID.test(c));
}

export function isSlackSourceConfigured(): boolean {
  return channelIds().length > 0 && (USE_FIXTURES || isSlackConfigured());
}

const tsMs = (ts: string) => Math.round(Number(ts) * 1000);

export function permalink(workspaceUrl: string, channelId: string, ts: string, threadTs?: string): string {
  const base = `${workspaceUrl.replace(/\/+$/, "")}/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base;
}

const isHuman = (m: RawMessage) => !m.bot_id && !m.subtype && Boolean(m.text?.trim());

/**
 * Pure: keep allowlisted channels and threads with any human activity in the window.
 * A thread started last week with a decision this week still counts.
 */
export function scopeThreads(channels: RawChannel[], allowed: string[], w: TimeWindow, workspaceUrl: string): SlackThread[] {
  const since = w.since.getTime();
  const until = w.until.getTime();
  const inWin = (m: RawMessage) => tsMs(m.ts) >= since && tsMs(m.ts) <= until;
  const toMessage = (channelId: string, m: RawMessage, threadTs?: string): SlackMessage => ({
    ts: m.ts,
    author: m.userName ?? m.user ?? "unknown",
    text: m.text.slice(0, MAX_TEXT_CHARS),
    permalink: permalink(workspaceUrl, channelId, m.ts, threadTs),
  });

  const threads: SlackThread[] = [];
  for (const channel of channels) {
    if (!allowed.includes(channel.id)) continue;
    for (const parent of channel.messages) {
      if (!isHuman(parent)) continue;
      const replies = (parent.replies ?? []).filter(isHuman);
      if (!inWin(parent) && !replies.some(inWin)) continue;
      threads.push({
        ...toMessage(channel.id, parent),
        channelId: channel.id,
        channelName: channel.name,
        replies: replies
          .filter((r) => tsMs(r.ts) <= until)
          .slice(0, MAX_REPLIES)
          .map((r) => toMessage(channel.id, r, parent.ts)),
      });
    }
  }
  return threads.sort((a, b) => Number(a.ts) - Number(b.ts));
}

const userNames = new Map<string, string>();

async function userName(id: string): Promise<string> {
  const cached = userNames.get(id);
  if (cached) return cached;
  const res = await slackClient().users.info({ user: id }).catch(() => undefined);
  const name = res?.user?.profile?.display_name || res?.user?.real_name || res?.user?.name || id;
  userNames.set(id, name);
  return name;
}

let workspaceUrlCache: string | undefined;

async function workspaceUrl(): Promise<string> {
  if (USE_FIXTURES) return "https://example.slack.com";
  workspaceUrlCache ??= (await slackClient().auth.test()).url ?? "https://slack.com";
  return workspaceUrlCache;
}

async function withNames(messages: RawMessage[]): Promise<RawMessage[]> {
  return Promise.all(messages.map(async (m) => ({ ...m, userName: m.user ? await userName(m.user) : undefined })));
}

async function fetchChannel(id: string, w: TimeWindow): Promise<RawChannel | { id: string; error: string }> {
  const client = slackClient();
  try {
    const info = await client.conversations.info({ channel: id });
    // Look back an extra week so threads started earlier but active now are found.
    const oldest = String((w.since.getTime() - 7 * 86_400_000) / 1000);
    const latest = String(w.until.getTime() / 1000);
    const messages: RawMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.conversations.history({ channel: id, oldest, latest, limit: 200, cursor });
      messages.push(...((page.messages ?? []) as RawMessage[]));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor && messages.length < MAX_MESSAGES_PER_CHANNEL);

    for (const m of messages) {
      if (!m.reply_count) continue;
      const thread = await client.conversations.replies({ channel: id, ts: m.ts, limit: MAX_REPLIES + 1 });
      m.replies = await withNames(((thread.messages ?? []) as RawMessage[]).filter((r) => r.ts !== m.ts));
    }
    return { id, name: info.channel?.name ?? id, messages: await withNames(messages) };
  } catch (err) {
    if (isNotInChannel(err)) return { id, error: "bot is not a member of this channel" };
    throw err;
  }
}

export async function readDesignThreads(w: TimeWindow): Promise<{ threads: SlackThread[]; skipped: { id: string; error: string }[] }> {
  const allowed = channelIds();
  if (USE_FIXTURES) {
    const channels = loadFixture<RawChannel[]>("slack");
    return { threads: scopeThreads(channels, allowed, w, await workspaceUrl()), skipped: [] };
  }
  const results = await Promise.all(allowed.map((id) => fetchChannel(id, w)));
  const channels = results.filter((r): r is RawChannel => "messages" in r);
  const skipped = results.filter((r): r is { id: string; error: string } => "error" in r);
  return { threads: scopeThreads(channels, allowed, w, await workspaceUrl()), skipped };
}
