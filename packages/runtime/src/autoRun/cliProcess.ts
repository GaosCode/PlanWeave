import type { ExecutorRuntimeLimits } from "./executorShared.js";
import {
  runStreamingCommandWithSessionCapture,
  type StreamedCommandResult
} from "./streamingExecutor.js";
import { createTmuxSessionInfo, type TmuxSessionInfo } from "./tmuxExecutor.js";

export interface CliProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  limits: ExecutorRuntimeLimits;
  signal?: AbortSignal;
  tmux: {
    runDir: string;
    runId: string;
    ownerRunId?: string;
    ref?: string;
    kind: "block" | "feedback";
    enabled?: boolean;
  };
  sessionIdFromOutput?: (output: string) => string | null;
  onSessionId?: (sessionId: string) => Promise<void>;
  onTmuxReady?: (tmux: TmuxSessionInfo | null) => Promise<void>;
}

export type CliProcessResult = StreamedCommandResult & {
  tmux: TmuxSessionInfo | null;
};

export type CliProcessExecutor = (request: CliProcessRequest) => Promise<CliProcessResult>;

/** Owns one CLI process attempt, including optional tmux and streamed output capture. */
export const executeCliProcess: CliProcessExecutor = async (request) => {
  const tmux = await createTmuxSessionInfo({
    runDir: request.tmux.runDir,
    runId: request.tmux.runId,
    tmuxOwnerRunId: request.tmux.ownerRunId,
    ref: request.tmux.ref,
    kind: request.tmux.kind,
    enabled: request.tmux.enabled
  });
  await request.onTmuxReady?.(tmux);
  const result = await runStreamingCommandWithSessionCapture({
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    stdin: request.stdin,
    env: request.env,
    timeoutMs: request.limits.timeoutMs,
    maxStdoutBytes: request.limits.maxStdoutBytes,
    maxStderrBytes: request.limits.maxStderrBytes,
    stdoutPath: request.stdoutPath,
    stderrPath: request.stderrPath,
    tmux,
    sessionIdFromOutput: request.sessionIdFromOutput ?? (() => null),
    onSessionId: request.onSessionId ?? (() => Promise.resolve()),
    signal: request.signal
  });
  return { ...result, tmux };
};
