export interface GitHubCreatePROptions {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  mergeable: boolean | null;
}

export interface GitHubPRDetail extends GitHubPR {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeStateStatus: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
}

export interface GitHubRepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  htmlUrl: string;
}
