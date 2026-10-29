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

const ISSUES_QUERY = `
query DesignIssues($filter: IssueFilter!, $after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes {
      identifier title url description createdAt updatedAt startedAt completedAt
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

/** Pure scope check, shared by live and fixture paths. */
export function inScope(issue: LinearIssue, { teams, assignees }: LinearScope, w: TimeWindow): boolean {
  if (teams.length + assignees.length === 0) return false;
  if (teams.length > 0 && !teams.includes(issue.teamKey.toUpperCase())) return false;
  if (assignees.length > 0 && !(issue.assigneeEmail && assignees.includes(issue.assigneeEmail))) return false;
  return inWindow(issue.updatedAt, w);
}

export function issueFilter({ teams, assignees }: LinearScope, since: Date): Record<string, unknown> {
  return {
    updatedAt: { gte: since.toISOString() },
    ...(teams.length > 0 && { team: { key: { in: teams } } }),
    ...(assignees.length > 0 && { assignee: { email: { in: assignees } } }),
  };
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

async function fetchNodes(scope: LinearScope, w: TimeWindow): Promise<{ nodes: LinearIssueNode[]; truncated: boolean }> {
  if (USE_FIXTURES) return { nodes: loadFixture<LinearIssueNode[]>("linear"), truncated: false };

  const nodes: LinearIssueNode[] = [];
  let after: string | null = null;
  do {
    const page: IssuesPage = await gql<IssuesPage>(ISSUES_QUERY, { filter: issueFilter(scope, w.since), after });
    nodes.push(...page.issues.nodes);
    after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
  } while (after && nodes.length < MAX_ISSUES);
  return { nodes, truncated: Boolean(after) };
}

export async function listDesignIssues(w: TimeWindow): Promise<{ issues: LinearIssue[]; truncated: boolean }> {
  const scope = linearScope();
  if (scope.teams.length + scope.assignees.length === 0) throw new Error("Missing LINEAR_TEAM_KEYS or LINEAR_ASSIGNEE_EMAILS");
  const { nodes, truncated } = await fetchNodes(scope, w);
  const issues = nodes.map(normalize).filter((i) => inScope(i, scope, w));
  issues.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { issues, truncated };
}
