export interface LinearComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
  teamKey: string;
  state: string;
  /** Linear workflow category: triage, backlog, unstarted, started, completed, canceled. */
  stateType: string;
  assignee: string | null;
  assigneeEmail: string | null;
  project: string | null;
  labels: string[];
  description: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  links: { title: string; url: string }[];
  comments: LinearComment[];
}

/** Raw GraphQL node shape; fixtures use the same shape so both paths share normalize(). */
export interface LinearIssueNode {
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  team: { key: string };
  state: { name: string; type: string };
  assignee: { name: string; email?: string | null } | null;
  project: { name: string } | null;
  labels: { nodes: { name: string }[] };
  attachments: { nodes: { title: string | null; url: string }[] };
  comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] };
}
