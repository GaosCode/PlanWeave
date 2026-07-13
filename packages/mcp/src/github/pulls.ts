import { ghRequest } from "./client.js";
import type { GitHubCreatePROptions, GitHubPR, GitHubPRDetail } from "./types.js";

export async function createPR(
  owner: string,
  repo: string,
  options: GitHubCreatePROptions,
): Promise<GitHubPR> {
  const data = await ghRequest<Record<string, unknown>>(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: options.title,
      head: options.head,
      base: options.base,
      body: options.body ?? "",
      draft: options.draft ?? false,
    }),
  });

  return {
    number: data.number as number,
    title: data.title as string,
    state: data.state as string,
    htmlUrl: data.html_url as string,
    headBranch: (data.head as Record<string, string>).ref,
    baseBranch: (data.base as Record<string, string>).ref,
    author: (data.user as Record<string, string>).login,
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
    draft: data.draft as boolean,
    mergeable: data.mergeable as boolean | null,
  };
}

export async function listPRs(
  owner: string,
  repo: string,
  options: { state?: "open" | "closed" | "all"; perPage?: number } = {},
): Promise<GitHubPR[]> {
  const params = new URLSearchParams();
  if (options.state) params.set("state", options.state);
  if (options.perPage) params.set("per_page", String(options.perPage));

  const query = params.toString();
  const path = `/repos/${owner}/${repo}/pulls${query ? `?${query}` : ""}`;

  const data = await ghRequest<Array<Record<string, unknown>>>(path);

  return data.map((pr) => ({
    number: pr.number as number,
    title: pr.title as string,
    state: pr.state as string,
    htmlUrl: pr.html_url as string,
    headBranch: (pr.head as Record<string, string>).ref,
    baseBranch: (pr.base as Record<string, string>).ref,
    author: (pr.user as Record<string, string>).login,
    createdAt: pr.created_at as string,
    updatedAt: pr.updated_at as string,
    draft: pr.draft as boolean,
    mergeable: pr.mergeable as boolean | null,
  }));
}

export async function getPR(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubPRDetail> {
  const data = await ghRequest<Record<string, unknown>>(
    `/repos/${owner}/${repo}/pulls/${prNumber}`,
  );

  return {
    number: data.number as number,
    title: data.title as string,
    state: data.state as string,
    htmlUrl: data.html_url as string,
    headBranch: (data.head as Record<string, string>).ref,
    baseBranch: (data.base as Record<string, string>).ref,
    author: (data.user as Record<string, string>).login,
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
    draft: data.draft as boolean,
    mergeable: data.mergeable as boolean | null,
    body: (data.body as string) ?? "",
    additions: data.additions as number,
    deletions: data.deletions as number,
    changedFiles: data.changed_files as number,
    mergeStateStatus: data.mergeable_state as string,
  };
}

export async function mergePR(
  owner: string,
  repo: string,
  prNumber: number,
  options: { method?: "merge" | "squash" | "rebase" } = {},
): Promise<{ merged: boolean; message: string }> {
  const data = await ghRequest<Record<string, unknown>>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
    {
      method: "PUT",
      body: JSON.stringify({
        merge_method: options.method ?? "merge",
      }),
    },
  );

  return {
    merged: data.merged as boolean,
    message: data.message as string,
  };
}
