import { execWithStreaming, type ExecutorOutputLimitExceeded } from "./executorShared.js";
import type { TmuxSessionInfo } from "./tmuxExecutor.js";

export type StreamedCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  limitExceeded?: ExecutorOutputLimitExceeded;
};

function appendScanBuffer(previous: string, chunk: string): string {
  return `${previous}${chunk}`.slice(-8192);
}

async function readStreamedCommandResult(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  limitExceeded?: ExecutorOutputLimitExceeded;
}): Promise<StreamedCommandResult> {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    limitExceeded: result.limitExceeded
  };
}

export async function runStreamingCommandWithSessionCapture(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  stdoutPath: string;
  stderrPath: string;
  tmux?: TmuxSessionInfo | null;
  sessionIdFromOutput: (output: string) => string | null;
  onSessionId: (sessionId: string) => Promise<void>;
}): Promise<StreamedCommandResult> {
  let scanBuffer = "";
  let capturedSessionId: string | null = null;
  const captureSessionId = async (chunk: string): Promise<void> => {
    if (capturedSessionId) {
      return;
    }
    scanBuffer = appendScanBuffer(scanBuffer, chunk);
    const sessionId = options.sessionIdFromOutput(scanBuffer);
    if (!sessionId) {
      return;
    }
    capturedSessionId = sessionId;
    await options.onSessionId(sessionId);
  };

  const result = await execWithStreaming({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    stdin: options.stdin,
    env: options.env,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
    tmux: options.tmux,
    onStdout: captureSessionId,
    onStderr: captureSessionId
  });
  return readStreamedCommandResult(result);
}
