// Linear GraphQL client. LINEAR_TEAM_KEYS and LINEAR_ASSIGNEE_EMAILS are the scope
// boundary: each set one goes into every query and is re-checked on every returned
// issue, so the model can never widen it. LINEAR_API_KEY is a vault placeholder.
import { envList, USE_FIXTURES } from "../config.js";
import { loadFixture } from "../fixtures.js";
import { inWindow, type TimeWindow } from "../run-context.js";
import type { LinearIssue, LinearIssueNode } from "./types.js";

const API_URL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 50;
const MAX_ISSUES = 250;
const MAX_DESCRIPTION_CHARS = 1_500;
const MAX_COMMENTS = 5;
const MAX_OPEN = 50;
// "Todo" and "In Progress" style states; backlog stays out.
const OPEN_STATE_TYPES = ["unstarted", "started"];

const ISSUES_QUERY = `
query DesignIssues($filter: IssueFilter!, $after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes {
      identifier title url description createdAt updatedAt startedAt completedAt priorityLabel dueDate
      team { key }
      state { name type }
      assignee { name email }
      project { name }
      labels { nodes { name } }
      attachments { nodes { title url } }
      comments(first: ${MAX_COMMENTS}) { nodes { body createdAt user { name } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function teamKeys(): string[] {
  return envList("LINEAR_TEAM_KEYS").map((k) => k.toUpperCase());
}

/** People whose assigned issues are in scope. Empty means every assignee. */
export function assigneeEmails(): string[] {
  return envList("LINEAR_ASSIGNEE_EMAILS").map((e) => e.toLowerCase());
}

export interface LinearScope {
  teams: string[];
  assignees: string[];
}

export function linearScope(): LinearScope {
  return { teams: teamKeys(), assignees: assigneeEmails() };
}

export function describeScope({ teams, assignees }: LinearScope): string {
  return [teams.length > 0 && `team(s) ${teams.join(", ")}`, assignees.length > 0 && `assigned to ${assignees.join(", ")}`]
    .filter(Boolean)
    .join(", ");
}

export function isLinearConfigured(): boolean {
  const { teams, assignees } = linearScope();
  return teams.length + assignees.length > 0 && (USE_FIXTURES || Boolean(process.env.LINEAR_API_KEY));
}

export function normalize(node: LinearIssueNode): LinearIssue {
  return {
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    teamKey: node.team.key,
    state: node.state.name,
    stateType: node.state.type,
    assignee: node.assignee?.name ?? null,
    assigneeEmail: node.assignee?.email?.toLowerCase() ?? null,
    priority: node.priorityLabel && node.priorityLabel !== "No priority" ? node.priorityLabel : null,
    dueDate: node.dueDate ?? null,
    project: node.project?.name ?? null,
    labels: node.labels.nodes.map((l) => l.name),
    description: (node.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    startedAt: node.startedAt,
    completedAt: node.completedAt,
    links: node.attachments.nodes.map((a) => ({ title: a.title ?? a.url, url: a.url })),
    comments: node.comments.nodes.slice(0, MAX_COMMENTS).map((c) => ({
      author: c.user?.name ?? "unknown",
      body: c.body,
      createdAt: c.createdAt,
    })),
  };
}

function matchesScope(issue: LinearIssue, { teams, assignees }: LinearScope): boolean {
  if (teams.length + assignees.length === 0) return false;
  if (teams.length > 0 && !teams.includes(issue.teamKey.toUpperCase())) return false;
  return assignees.length === 0 || Boolean(issue.assigneeEmail && assignees.includes(issue.assigneeEmail));
}

/** Pure scope check, shared by live and fixture paths. */
export function inScope(issue: LinearIssue, scope: LinearScope, w: TimeWindow): boolean {
  return matchesScope(issue, scope) && inWindow(issue.updatedAt, w);
}

/** Open work in scope, however long since it was touched. */
export function inOpenScope(issue: LinearIssue, scope: LinearScope): boolean {
  return matchesScope(issue, scope) && OPEN_STATE_TYPES.includes(issue.stateType);
}

function scopeFilter({ teams, assignees }: LinearScope): Record<string, unknown> {
  return {
    ...(teams.length > 0 && { team: { key: { in: teams } } }),
    ...(assignees.length > 0 && { assignee: { email: { in: assignees } } }),
  };
}

export function issueFilter(scope: LinearScope, since: Date): Record<string, unknown> {
  return { updatedAt: { gte: since.toISOString() }, ...scopeFilter(scope) };
}

export function openIssueFilter(scope: LinearScope): Record<string, unknown> {
  return { state: { type: { in: OPEN_STATE_TYPES } }, ...scopeFilter(scope) };
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("Missing LINEAR_API_KEY");
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) {
    const detail = body.errors?.map((e) => e.message).join("; ") ?? "";
    throw new Error(`Linear API error: ${res.status} ${res.statusText}. ${detail}`.trim());
  }
  return body.data as T;
}

interface IssuesPage {
  issues: { nodes: LinearIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

async function fetchNodes(filter: Record<string, unknown>, max: number): Promise<{ nodes: LinearIssueNode[]; truncated: boolean }> {
  if (USE_FIXTURES) return { nodes: loadFixture<LinearIssueNode[]>("linear"), truncated: false };

  const nodes: LinearIssueNode[] = [];
  let after: string | null = null;
  do {
    const page: IssuesPage = await gql<IssuesPage>(ISSUES_QUERY, { filter, after });
    nodes.push(...page.issues.nodes);
    after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
  } while (after && nodes.length < max);
  return { nodes, truncated: Boolean(after) };
}

/** Issues that changed in the window, plus open ones that didn't (candidates for next). */
export async function listDesignIssues(
  w: TimeWindow,
): Promise<{ issues: LinearIssue[]; open: LinearIssue[]; truncated: boolean }> {
  const scope = linearScope();
  if (scope.teams.length + scope.assignees.length === 0) throw new Error("Missing LINEAR_TEAM_KEYS or LINEAR_ASSIGNEE_EMAILS");
  const [changed, openNodes] = await Promise.all([
    fetchNodes(issueFilter(scope, w.since), MAX_ISSUES),
    fetchNodes(openIssueFilter(scope), MAX_OPEN),
  ]);
  const issues = changed.nodes.map(normalize).filter((i) => inScope(i, scope, w));
  const seen = new Set(issues.map((i) => i.identifier));
  const open = openNodes.nodes
    .map(normalize)
    .filter((i) => inOpenScope(i, scope) && !seen.has(i.identifier))
    .slice(0, MAX_OPEN);
  issues.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  open.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { issues, open, truncated: changed.truncated || openNodes.truncated };
}
