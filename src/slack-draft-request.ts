// "draft this week's update", "can u draft the design update?", "write the weekly recap pls"
export const DRAFT_REQUEST = /\b(draft|generate|write|put together)\b[^.?!\n]*\b(update|digest|summary|recap)\b/i;

/** What's left of a draft request once the request itself is removed ("btw I also worked on…"). */
export function checkInFrom(message: string): string | undefined {
  const rest = message
    .replace(DRAFT_REQUEST, "")
    .replace(/^[\s,.!?:;-]*(can (you|u)|could (you|u)|pls|please|hey|hi)?[\s,.!?:;-]*/i, "")
    .trim();
  return rest.replace(/[^a-z0-9]/gi, "").length >= 8 ? rest : undefined;
}
