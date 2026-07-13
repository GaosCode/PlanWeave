export interface FileStatus {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: FileStatus[];
  clean: boolean;
}

export interface GitCommit {
  hash: string;
  abbreviatedHash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitDiffHunk {
  header: string;
  lines: string[];
}

export interface GitDiffResult {
  hunks: GitDiffHunk[];
  raw: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitRepoInfo {
  owner: string | null;
  repo: string | null;
  remotes: GitRemote[];
  defaultRemote: string | null;
}

export interface GitCommitResult {
  hash: string;
  message: string;
}

export interface GitPushPullResult {
  success: boolean;
  output: string;
}
