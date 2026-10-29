import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readDoc, searchDocs } from "../store.js";
import { recordSource, type RunContext } from "../../run-context.js";
import { text, untrusted } from "../../tool-result.js";

const sourceId = (p: string) => `doc:${p}`;

export function knowledgeTools(ctx: RunContext) {
  const search = tool(
    "search_design_knowledge",
    "Search the design team's curated reference docs (brand, components, process, tools) for a standing design question. This is the ONLY authorized source for reference answers. If nothing relevant comes back, say you don't have that documented instead of answering from general knowledge.",
    { query: z.string().min(2).describe("Keywords, e.g. 'brand colors' or 'component library'.") },
    async (args) => {
      const hits = searchDocs(args.query);
      if (hits.length === 0) return text(`No design docs match "${args.query}".`);
      for (const h of hits) recordSource(ctx, { id: sourceId(h.doc.path), kind: "doc", title: h.doc.title });
      return text(
        hits
          .map((h) => `- ${h.doc.title} (path: ${h.doc.path}, source_id: ${sourceId(h.doc.path)})\n  …${h.snippet}…`)
          .join("\n"),
      );
    },
  );

  const read = tool(
    "read_design_doc",
    "Read one design reference doc in full by the path returned from search_design_knowledge.",
    { path: z.string().describe("Relative path from search results, e.g. 'brand.md'.") },
    async (args) => {
      const doc = readDoc(args.path);
      if (!doc) return text(`There's no design doc at "${args.path}".`);
      recordSource(ctx, { id: sourceId(doc.path), kind: "doc", title: doc.title });
      return text(`source_id: ${sourceId(doc.path)}\n${untrusted(sourceId(doc.path), doc.body)}`);
    },
  );

  return [search, read];
}
