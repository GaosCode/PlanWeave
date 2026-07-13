import type { GitStatus } from "@planweave-ai/runtime";
import type { TokenStatus } from "@planweave-ai/mcp/github";

export type GitHubAuthStatus = TokenStatus;

export type ProjectGitStatus = {
  status: GitStatus | null;
  error: string | null;
};

export const gitIntegrationInvokeChannels = {
  getGitStatus: "planweave-git:getGitStatus",
  getGitHubAuthStatus: "planweave-git:getGitHubAuthStatus",
  gitHubLogin: "planweave-git:gitHubLogin",
  gitHubLogout: "planweave-git:gitHubLogout",
} as const;

export type PlanWeaveGitIntegrationApi = {
  getGitStatus: (projectId: string) => Promise<ProjectGitStatus>;
  getGitHubAuthStatus: () => Promise<GitHubAuthStatus>;
  gitHubLogin: (token: string) => Promise<GitHubAuthStatus>;
  gitHubLogout: () => Promise<void>;
};
