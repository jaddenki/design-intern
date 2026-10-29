import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { inWindow, windowFor, type RunContext } from "../run-context.js";
import { runTool, text } from "../tool-result.js";
import { authorizedFiles } from "./projects.js";

export function figmaIndexTools(ctx: RunContext) {
  return [
    tool(
      "list_figma_files",
      "List the Figma files you're authorized to open (single files plus every file in the authorized Figma projects), with last-modified times, files changed in the reporting window first. Use it to find active design work, then open a file with get_figma_data. Listing a file is not evidence by itself; open it before citing it.",
      { days: z.number().int().min(1).max(14).optional().describe("Window length in days, default 7.") },
      async (args) =>
        runTool(
          "I couldn't list Figma files just now.",
          async () => {
            const w = windowFor(ctx, args.days);
            const { files, errors } = await authorizedFiles();
            if (files.length === 0) return text("No Figma files or projects are authorized (FIGMA_FILE_KEYS / FIGMA_PROJECT_IDS).");
            const sorted = [...files].sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
            const lines = sorted.map((f) => {
              const active = inWindow(f.lastModified, w) ? " (changed in window)" : "";
              const where = f.project ? ` in ${f.project}` : "";
              return `- ${f.name}${where} · fileKey: ${f.key} · modified: ${f.lastModified ?? "unknown"}${active}`;
            });
            return text([`Authorized Figma files: ${files.length}`, ...errors.map((e) => `Couldn't list a project: ${e}`), ...lines].join("\n"));
          },
          "Figma list error:",
        ),
    ),
  ];
}
