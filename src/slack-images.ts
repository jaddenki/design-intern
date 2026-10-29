// Brand assets the agent links to are shown inline as Slack image blocks. Only the
// brand site's public assets qualify, so a reply can't make the bot display an
// arbitrary URL. Slack can't render SVG, so a logo's PNG twin stands in.
import type { KnownBlock } from "@slack/web-api";

const ASSET = /https:\/\/infisical-brand\.vercel\.app\/assets\/[\w/-]+\.(png|jpe?g|gif|svg)\b/gi;
const MAX_IMAGES = 4;

export function brandImages(text: string): { url: string; name: string }[] {
  const urls = new Set<string>();
  for (const [match] of text.matchAll(ASSET)) {
    const url = match.replace(/\.svg$/i, ".png");
    if (url.endsWith(".svg")) continue;
    urls.add(url);
  }
  return [...urls].slice(0, MAX_IMAGES).map((url) => ({ url, name: url.split("/").pop()! }));
}

export function imageBlocks(images: { url: string; name: string }[]): KnownBlock[] {
  const blocks: KnownBlock[] = images.map(({ url, name }) => ({ type: "image", image_url: url, alt_text: name, title: { type: "plain_text", text: name } }));
  if (images.some((i) => /_white\./.test(i.name))) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "White logos have a transparent background, so they only show up on Slack's dark theme." }] });
  }
  return blocks;
}
