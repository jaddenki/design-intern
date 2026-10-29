// Last-line check on anything leaving the agent (answers, draft lines, Slack posts).
// The agent never holds credentials, so a match means something is badly wrong.
const PATTERNS: RegExp[] = [
  /xox[abprs]-[A-Za-z0-9-]{8,}/,
  /xapp-[A-Za-z0-9-]{8,}/,
  /lin_(api|oauth)_[A-Za-z0-9]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /figd_[A-Za-z0-9_-]{16,}/,
  /sk-ant-[A-Za-z0-9_-]{16,}/,
  // agent-vault placeholders, e.g. __slack_bot_token__
  /__[a-z0-9]+(?:_[a-z0-9]+)+__/,
];

export function containsSecret(value: string): boolean {
  return PATTERNS.some((p) => p.test(value));
}
