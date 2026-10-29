import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { describeScope, isLinearConfigured, linearScope, listDesignIssues } from "../client.js";
import type { LinearIssue } from "../types.js";
import { recordSource, windowFor, type RunContext } from "../../run-context.js";
import { runTool, text, untrusted } from "../../tool-result.js";

export function sourceId(issue: LinearIssue): string {
  return `linear:${issue.identifier}`;
}

function render(issue: LinearIssue): string {
  const meta = [
    `state: ${issue.state} (${issue.stateType})`,
    issue.assignee && `assignee: ${issue.assignee}`,
    issue.priority && `priority: ${issue.priority}`,
    issue.dueDate && `due: ${issue.dueDate}`,
    issue.project && `project: ${issue.project}`,
    issue.labels.length > 0 && `labels: ${issue.labels.join(", ")}`,
    `updated: ${issue.updatedAt}`,
    issue.startedAt && `started: ${issue.startedAt}`,
    issue.completedAt && `completed: ${issue.completedAt}`,
  ].filter(Boolean);
  const links = issue.links.map((l) => `  - ${l.title}: ${l.url}`).join("\n");
  const comments = issue.comments.map((c) => `  - ${c.author} (${c.createdAt}): ${c.body}`).join("\n");
  const body = [
    issue.description && `Description:\n${issue.description}`,
    comments && `Recent comments:\n${comments}`,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    `### ${issue.identifier} · ${issue.title}`,
    `source_id: ${sourceId(issue)}`,
    `url: ${issue.url}`,
    meta.join(" | "),
    links && `Links:\n${links}`,
    body && untrusted(sourceId(issue), body),
  ]
    .filter(Boolean)
    .join("\n");
}

export function listDesignIssuesTool(ctx: RunContext) {
  return tool(
    "list_design_issues",
    "List Linear issues for the design team that changed in the reporting window (default the last 7 days), plus open issues (todo or in progress) that didn't change, as candidates for what to pick up next. Scoped to the configured design team(s) and/or assignees; takes no scope argument. Each issue shows its state category (completed = shipped), dates, assignee, project, attached links (often Figma files or GitHub PRs), and recent comments. Cite issues by their source_id.",
    {
      days: z.number().int().min(1).max(14).optional().describe("Window length in days, default 7."),
    },
    async (args) => {
      if (!isLinearConfigured()) {
        return text("Linear isn't configured (LINEAR_API_KEY, plus LINEAR_TEAM_KEYS or LINEAR_ASSIGNEE_EMAILS), so I can't read design issues.");
      }
      return runTool(
        "I couldn't reach Linear just now.",
        async () => {
          const w = windowFor(ctx, args.days);
          const { issues, open, truncated } = await listDesignIssues(w);
          for (const issue of [...issues, ...open]) {
            recordSource(ctx, { id: sourceId(issue), kind: "linear", title: `${issue.identifier} ${issue.title}`, url: issue.url });
          }
          const header = `Linear issues for ${describeScope(linearScope())} updated ${w.since.toISOString()} → ${w.until.toISOString()}: ${issues.length}${truncated ? " (truncated)" : ""}`;
          const openHeader = `Open issues not updated in the window (todo or in progress), candidates for next: ${open.length}`;
          return text([header, ...issues.map(render), openHeader, ...open.map(render)].join("\n\n"));
        },
        "Linear API error:",
      );
    },
  );
}
