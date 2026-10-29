// Slack refuses chat.update text over about 4,000 characters (msg_too_long), and a
// full logo SVG alone is longer. Long replies go out as several thread messages,
// closing and reopening code fences at each split so every part renders.
export const SLACK_CHUNK_CHARS = 3_500;

export function splitForSlack(text: string, max = SLACK_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  let fence: string | undefined;

  const push = () => {
    if (!current.trim()) return;
    chunks.push(fence ? `${current}\n\`\`\`` : current);
    current = fence ? `${fence}\n` : "";
  };

  for (const raw of text.split("\n")) {
    // Lines longer than a chunk (SVG path data) are hard-split.
    const room = max - 20;
    const pieces = raw.length > room ? (raw.match(new RegExp(`.{1,${room}}`, "g")) ?? [raw]) : [raw];
    for (const line of pieces) {
      if (current.length + line.length + 1 > max - 4) push();
      current += current && !current.endsWith("\n") ? `\n${line}` : line;
      const marker = line.trim().match(/^```(\w*)/);
      if (marker) fence = fence ? undefined : `\`\`\`${marker[1]}`;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}
