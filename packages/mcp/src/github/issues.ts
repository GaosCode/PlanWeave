import { ghRequest } from "./client.js";
import type { GitHubIssue } from "./types.js";

export async function listIssues(
  owner: string,
  repo: string,
  options: { state?: "open" | "closed" | "all"; perPage?: number; labels?: string[] } = {},
): Promise<GitHubIssue[]> {
  const params = new URLSearchParams();
  if (options.state) params.set("state", options.state);
  if (options.perPage) params.set("per_page", String(options.perPage));
  if (options.labels?.length) params.set("labels", options.labels.join(","));

  const query = params.toString();
  const path = `/repos/${owner}/${repo}/issues${query ? `?${query}` : ""}`;

  const data = await ghRequest<Array<Record<string, unknown>>>(path);

  return data
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number as number,
      title: issue.title as string,
      state: issue.state as string,
      htmlUrl: issue.html_url as string,
      author: (issue.user as Record<string, string>).login,
      createdAt: issue.created_at as string,
      updatedAt: issue.updated_at as string,
      labels: (issue.labels as Array<{ name: string }>).map((l) => l.name),
    }));
}

export async function getRepoInfo(owner: string, repo: string): Promise<{
  owner: string;
  repo: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  htmlUrl: string;
}> {
  const data = await ghRequest<Record<string, unknown>>(`/repos/${owner}/${repo}`);

  return {
    owner: data.owner ? (data.owner as Record<string, string>).login : owner,
    repo: data.name as string,
    fullName: data.full_name as string,
    description: (data.description as string) ?? "",
    defaultBranch: data.default_branch as string,
    htmlUrl: data.html_url as string,
  };
}
