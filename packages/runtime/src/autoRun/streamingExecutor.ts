import { readFile } from "node:fs/promises";
import { execWithStreaming } from "./executorShared.js";
import type { TmuxSessionInfo } from "./tmuxExecutor.js";

export type StreamedCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

function appendScanBuffer(previous: string, chunk: string): string {
  return `${previous}${chunk}`.slice(-8192);
}

async function readStreamedCommandResult(result: {
  stdoutPath: string;
  stderrPath: string;
  exitCode: number;
  timedOut: boolean;
}): Promise<StreamedCommandResult> {
  const [stdout, stderr] = await Promise.all([readFile(result.stdoutPath, "utf8"), readFile(result.stderrPath, "utf8")]);
  return { stdout, stderr, exitCode: result.exitCode, timedOut: result.timedOut };
}

export async function runStreamingCommandWithSessionCapture(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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
    tmux: options.tmux,
    onStdout: captureSessionId,
    onStderr: captureSessionId
  });
  return readStreamedCommandResult(result);
}
