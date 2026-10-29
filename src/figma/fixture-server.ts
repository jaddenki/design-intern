// Demo-mode stand-in for the external Figma server: same server name, tool name, and
// argument, so the scope and source hooks in external-mcp.ts run exactly as in prod.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadFixture } from "../fixtures.js";
import { text, untrusted } from "../tool-result.js";

interface FigmaFixtureFile {
  fileKey: string;
  name: string;
  lastModified: string;
  pages: { name: string; frames: string[] }[];
}

export function figmaFixtureTools() {
  return [
    tool(
      "get_figma_data",
      "Get a Figma file's name, last-modified time, pages, and top-level frames.",
      {
        fileKey: z.string().describe("The Figma file key from a figma.com/design/<fileKey>/ URL."),
        nodeId: z.string().optional(),
        depth: z.number().optional(),
      },
      async (args) => {
        const file = loadFixture<FigmaFixtureFile[]>("figma").find((f) => f.fileKey === args.fileKey);
        if (!file) return { ...text(`Figma file ${args.fileKey} not found.`), isError: true };
        const pages = file.pages.map((p) => `- page: ${p.name}\n${p.frames.map((f) => `    - frame: ${f}`).join("\n")}`);
        return text(
          untrusted(`figma:${file.fileKey}`, [`name: ${file.name}`, `lastModified: ${file.lastModified}`, "pages:", ...pages].join("\n")),
        );
      },
    ),
  ];
}
