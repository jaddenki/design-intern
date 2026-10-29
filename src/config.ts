import { fileURLToPath } from "node:url";
import path from "node:path";

export const AGENT_NAME = process.env.AGENT_NAME?.trim() || "Design Intern";

// dist/ and src/ sit at the same depth, so this resolves under tsx and node.
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Set only by the eval and tests: read the fictional week in fixtures/ instead of live APIs.
export const USE_FIXTURES = process.env.DATA_SOURCE?.trim() === "fixtures";

// "modal" runs each agent turn in a disposable Modal Sandbox (src/sandbox/).
export const AGENT_RUNNER = process.env.AGENT_RUNNER?.trim() === "modal" ? "modal" : "local";

export const DRAFT_MODEL = process.env.DRAFT_MODEL?.trim() || "claude-opus-5-5";
export const CHAT_MODEL = process.env.CHAT_MODEL?.trim() || "claude-sonnet-5-5";
// Short reference and asset answers ("white logo as SVG") don't need the chat model.
export const REFERENCE_MODEL = process.env.REFERENCE_MODEL?.trim() || "claude-haiku-5-5";

export const DATA_DIR = path.resolve(APP_ROOT, process.env.DATA_DIR?.trim() || "data");

// The posted message. {{last_week}}, {{priorities}}, and {{date_range}} are filled in.
export const UPDATE_TEMPLATE = path.resolve(APP_ROOT, process.env.UPDATE_TEMPLATE?.trim() || "templates/weekly-update.md");

export const KNOWLEDGE_DIR = path.resolve(
  APP_ROOT,
  process.env.DESIGN_KNOWLEDGE_DIR?.trim() || (USE_FIXTURES ? "fixtures/knowledge" : "knowledge"),
);

/** Comma- or whitespace-separated env list, trimmed, blanks dropped. */
export function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export const DEFAULT_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 14;
