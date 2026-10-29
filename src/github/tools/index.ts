import type { RunContext } from "../../run-context.js";
import { listDesignPrsTool } from "./list-design-prs.js";

export function githubTools(ctx: RunContext) {
  return [listDesignPrsTool(ctx)];
}
