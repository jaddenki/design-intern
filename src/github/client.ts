// GitHub REST client for design-team pull requests. Two independent boundaries:
// GITHUB_REPOS limits which repos are read, DESIGN_GITHUB_LOGINS limits whose PRs
// are returned. Both are required; without logins the capability reports "not
// configured" instead of reading every engineer's PRs.
import { envList, USE_FIXTURES } from "../config.js";
import { loadFixture } from "../fixtures.js";
import { inWindow, type TimeWindow } from "../run-context.js";

const API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const PER_PAGE = 100;
const MAX_PAGES = 3;
const MAX_BODY_CHARS = 1_500;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  labels: string[];
  body: string;
}

/** The fields we read off a raw GitHub pulls payload; fixtures use the same shape. */
export interface PullResponse {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  labels: { name: string }[];
  body: string | null;
  base: { repo: { full_name: string } };
}

export function repos(): string[] {
  return envList("GITHUB_REPOS").filter((r) => REPO.test(r));
}

export function logins(): string[] {
  return envList("DESIGN_GITHUB_LOGINS").map((l) => l.toLowerCase());
}

export function isGithubConfigured(): boolean {
  return repos().length > 0 && logins().length > 0 && (USE_FIXTURES || Boolean(process.env.GITHUB_TOKEN));
}

export function normalize(raw: PullResponse): PullRequest {
  return {
    repo: raw.base.repo.full_name,
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    author: raw.user?.login ?? "unknown",
    state: raw.merged_at ? "merged" : raw.state,
    draft: Boolean(raw.draft),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    mergedAt: raw.merged_at,
    labels: raw.labels.map((l) => l.name),
    body: (raw.body ?? "").slice(0, MAX_BODY_CHARS),
  };
}

export function inScope(pr: PullRequest, allowedRepos: string[], allowedLogins: string[], w: TimeWindow): boolean {
  const repoOk = allowedRepos.some((r) => r.toLowerCase() === pr.repo.toLowerCase());
  return repoOk && allowedLogins.includes(pr.author.toLowerCase()) && inWindow(pr.updatedAt, w);
}

async function githubGet<T>(path: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "design-intern",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}. ${body.slice(0, 500)}`.trim());
  }
  return (await res.json()) as T;
}

async function fetchRepoPulls(repo: string, w: TimeWindow): Promise<PullResponse[]> {
  const out: PullResponse[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: String(PER_PAGE),
      page: String(page),
    });
    const pulls = await githubGet<PullResponse[]>(`/repos/${repo}/pulls?${params}`);
    out.push(...pulls);
    // Sorted by updated desc, so once we pass the window start we're done.
    const oldest = pulls.at(-1)?.updated_at;
    if (pulls.length < PER_PAGE || (oldest && Date.parse(oldest) < w.since.getTime())) break;
  }
  return out;
}

export async function listDesignPulls(w: TimeWindow): Promise<PullRequest[]> {
  const allowedRepos = repos();
  const allowedLogins = logins();
  const raw = USE_FIXTURES
    ? loadFixture<PullResponse[]>("github")
    : (await Promise.all(allowedRepos.map((r) => fetchRepoPulls(r, w)))).flat();
  return raw
    .map(normalize)
    .filter((pr) => inScope(pr, allowedRepos, allowedLogins, w))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
