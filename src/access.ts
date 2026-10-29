// Only the design team may query the agent or approve drafts. Gated on email so the
// list stays human-readable; slack.ts resolves a Slack user id to an email first.
import { envList } from "./config.js";

export const DESIGN_TEAM_ONLY_MESSAGE = "Sorry, I can only help members of the design team right now.";

function allowed(): Set<string> {
  return new Set(envList("DESIGN_ALLOWLIST").map((e) => e.toLowerCase()));
}

export function allowlistConfigured(): boolean {
  return allowed().size > 0;
}

/** Fails closed: a missing email or an empty allowlist returns false. */
export function isAllowedEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return allowed().has(email.trim().toLowerCase());
}
