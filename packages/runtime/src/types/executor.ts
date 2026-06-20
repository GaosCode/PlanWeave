import type { ClaimResult } from "./taskManager.js";

export const executorAdapter = {
  manual: "manual",
  codexExec: "codex-exec",
  opencodeExec: "opencode-exec",
  claudeCodeExec: "claude-code-exec",
  piExec: "pi-exec",
  localReview: "local-review"
} as const;

export const executorAdapters = [
  executorAdapter.manual,
  executorAdapter.codexExec,
  executorAdapter.opencodeExec,
  executorAdapter.claudeCodeExec,
  executorAdapter.piExec,
  executorAdapter.localReview
] as const;

export type ExecutorAdapterName = (typeof executorAdapters)[number];

export type ManualExecutorProfile = {
  adapter: "manual";
};

export type CodexExecExecutorProfile = {
  adapter: "codex-exec";
  command: string;
  args: string[];
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  role?: string;
  timeoutMs?: number;
};

export type OpencodeExecExecutorProfile = {
  adapter: "opencode-exec";
  command: string;
  args: string[];
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs?: number;
};

export type ClaudeCodeExecExecutorProfile = {
  adapter: "claude-code-exec";
  command: string;
  args: string[];
  timeoutMs?: number;
};

export type PiExecExecutorProfile = {
  adapter: "pi-exec";
  command: string;
  args: string[];
  timeoutMs?: number;
};

export type LocalReviewExecutorProfile = {
  adapter: "local-review";
  command: string;
  args: string[];
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs?: number;
};

export type ExecutorProfile =
  | ManualExecutorProfile
  | CodexExecExecutorProfile
  | OpencodeExecExecutorProfile
  | ClaudeCodeExecExecutorProfile
  | PiExecExecutorProfile
  | LocalReviewExecutorProfile;

export type ExecutorProfileSummary = ExecutorProfile & {
  name: string;
  source: "builtin" | "package";
};

export type ExecutorAdapterResult =
  | {
      kind: "block";
      reportPath: string;
      runId?: string;
      executor?: string;
      adapter?: ExecutorProfile["adapter"];
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      startedAt?: string;
      finishedAt?: string;
      agentSessionId?: string | null;
      codexSessionId?: string | null;
      opencodeSessionId?: string | null;
    }
  | {
      kind: "review";
      resultPath: string;
      runId?: string;
      executor?: string;
      adapter?: ExecutorProfile["adapter"];
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      startedAt?: string;
      finishedAt?: string;
      agentSessionId?: string | null;
      codexSessionId?: string | null;
      opencodeSessionId?: string | null;
    }
  | {
      kind: "feedback";
      reportPath: string;
      runId?: string;
      executor?: string;
      adapter?: ExecutorProfile["adapter"];
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      startedAt?: string;
      finishedAt?: string;
      agentSessionId?: string | null;
      codexSessionId?: string | null;
      opencodeSessionId?: string | null;
    }
  | {
      kind: "manual";
      promptPath: string;
      runDir: string;
      runId: string;
      executor: string;
      adapter: "manual";
      nextCommand: string;
    };

export type ExecutorAdapter = {
  runBlock(input: { claim: Extract<ClaimResult, { kind: "block" }>; prompt: string }): Promise<ExecutorAdapterResult>;
  runFeedback(input: { claim: Extract<ClaimResult, { kind: "feedback" }> }): Promise<ExecutorAdapterResult>;
};
