import type { RunContext } from "../../run-context.js";
import { readDesignChannelsTool } from "./read-design-channels.js";

export function slackSourceTools(ctx: RunContext) {
  return [readDesignChannelsTool(ctx)];
}
