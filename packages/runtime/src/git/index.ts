export { isGitRepo, gitExec, GitError } from "./client.js";
export type { GitExecOptions } from "./client.js";
export { getStatus, getDiff, getLog } from "./status.js";
export {
  hasUncommittedChanges,
  hasStagedChanges,
  stageFiles,
  stageAll,
  commit,
} from "./changes.js";
export {
  getBranches,
  getCurrentBranch,
  createBranch,
  checkout,
} from "./branch.js";
export {
  getRemotes,
  getRepoInfo,
  parseGitHubRemote,
  push,
  pull,
  fetch,
} from "./remote.js";
export type {
  FileStatus,
  GitStatus,
  GitCommit,
  GitBranch,
  GitDiffHunk,
  GitDiffResult,
  GitRemote,
  GitRepoInfo,
  GitCommitResult,
  GitPushPullResult,
} from "./types.js";
