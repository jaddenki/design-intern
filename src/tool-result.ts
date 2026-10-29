/** Wrap a plain string as the tool result shape the agent SDK expects. */
export function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Run a tool body; any thrown error becomes a friendly `errorMessage` result. */
export async function runTool<T>(
  errorMessage: string,
  body: () => Promise<T>,
  logLabel = "Tool error:",
): Promise<T | ReturnType<typeof text>> {
  try {
    return await body();
  } catch (err) {
    console.error(logLabel, err);
    return text(errorMessage);
  }
}

/**
 * Fence third-party text so the model treats it as data. Closing tags inside the
 * content are neutralized so a message can't break out of its fence.
 */
export function untrusted(sourceId: string, body: string): string {
  const safe = body.replace(/<\/?\s*untrusted_content/gi, "&lt;untrusted_content");
  return `<untrusted_content source="${sourceId}">\n${safe}\n</untrusted_content>`;
}
