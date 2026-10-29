import type { RunContext } from "../../run-context.js";
import { listDesignIssuesTool } from "./list-design-issues.js";

export function linearTools(ctx: RunContext) {
  return [listDesignIssuesTool(ctx)];
}
