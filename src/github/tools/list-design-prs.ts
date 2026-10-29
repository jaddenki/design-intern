import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { isGithubConfigured, listDesignPulls, logins, repos, type PullRequest } from "../client.js";
import { recordSource, windowFor, type RunContext } from "../../run-context.js";
import { runTool, text, untrusted } from "../../tool-result.js";

export function sourceId(pr: PullRequest): string {
  return `github:${pr.repo}#${pr.number}`;
}

function render(pr: PullRequest): string {
  const state = pr.state === "open" && pr.draft ? "open (draft)" : pr.state;
  const meta = [
    `state: ${state}`,
    `author: ${pr.author}`,
    pr.labels.length > 0 && `labels: ${pr.labels.join(", ")}`,
    `updated: ${pr.updatedAt}`,
    pr.mergedAt && `merged: ${pr.mergedAt}`,
  ].filter(Boolean);
  return [
    `### ${pr.repo}#${pr.number} · ${pr.title}`,
    `source_id: ${sourceId(pr)}`,
    `url: ${pr.url}`,
    meta.join(" | "),
    pr.body && untrusted(sourceId(pr), pr.body),
  ]
    .filter(Boolean)
    .join("\n");
}

export function listDesignPrsTool(ctx: RunContext) {
  return tool(
    "list_design_prs",
    "List GitHub pull requests authored by design-team members in the configured repositories that changed in the reporting window (default the last 7 days). Scope is fixed by configuration; takes no repo or author argument. state=merged means shipped to the main branch. PR bodies often link Linear issues or Figma files. Cite PRs by their source_id.",
    {
      days: z.number().int().min(1).max(14).optional().describe("Window length in days, default 7."),
    },
    async (args) => {
      if (!isGithubConfigured()) {
        return text("GitHub isn't configured (GITHUB_TOKEN, GITHUB_REPOS, DESIGN_GITHUB_LOGINS), so I can't read design PRs.");
      }
      return runTool(
        "I couldn't reach GitHub just now.",
        async () => {
          const w = windowFor(ctx, args.days);
          const pulls = await listDesignPulls(w);
          for (const pr of pulls) {
            recordSource(ctx, { id: sourceId(pr), kind: "github", title: `${pr.repo}#${pr.number} ${pr.title}`, url: pr.url });
          }
          const header = `Design PRs in ${repos().join(", ")} by ${logins().join(", ")} updated ${w.since.toISOString()} → ${w.until.toISOString()}: ${pulls.length}`;
          return text([header, ...pulls.map(render)].join("\n\n"));
        },
        "GitHub API error:",
      );
    },
  );
}
