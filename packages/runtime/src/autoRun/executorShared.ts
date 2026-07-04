import { spawn } from "node:child_process";
import { createWriteStream, constants } from "node:fs";
import type { WriteStream } from "node:fs";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import type { ClaimResult, ExecutorProfile, PackageWorkspaceRef, ProjectWorkspace } from "../types.js";
import { runCommandInTmux, type TmuxSessionInfo } from "./tmuxExecutor.js";

export type BlockClaim = Extract<ClaimResult, { kind: "block" }>;
export type FeedbackClaim = Extract<ClaimResult, { kind: "feedback" }>;

export const DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_EXECUTOR_MAX_STDOUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_EXECUTOR_MAX_STDERR_BYTES = 2 * 1024 * 1024;
export const DEFAULT_EXECUTOR_HEARTBEAT_INTERVAL_MS = 5 * 1000;
export const EXECUTOR_FORCE_KILL_GRACE_MS = 500;

export type ExecutorRuntimeLimits = {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
};

export type ExecutorOutputLimitExceeded = {
  stream: "stdout" | "stderr";
  limitBytes: number;
};

export type StreamingCommandResult = {
  stdoutPath: string;
  stderrPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  limitExceeded?: ExecutorOutputLimitExceeded;
};

type ExecutorHeartbeatStatus = "running" | "finished" | "failed";

type ExecutorHeartbeatState = {
  status: ExecutorHeartbeatStatus;
  pid: number | null;
  startedAt: string;
  lastHeartbeatAt: string;
  lastStdoutAt: string | null;
  lastStderrAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  timedOut: boolean | null;
  error: string | null;
};

export type StdinCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  limitExceeded?: ExecutorOutputLimitExceeded;
};

export function executorRuntimeLimits(profile: Pick<ExecutorProfile, "adapter"> & Partial<ExecutorRuntimeLimits>): ExecutorRuntimeLimits {
  return {
    timeoutMs: profile.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS,
    maxStdoutBytes: profile.maxStdoutBytes ?? DEFAULT_EXECUTOR_MAX_STDOUT_BYTES,
    maxStderrBytes: profile.maxStderrBytes ?? DEFAULT_EXECUTOR_MAX_STDERR_BYTES
  };
}

export function executorLimitFailureMessage(input: { executorName: string; limitExceeded: ExecutorOutputLimitExceeded }): string {
  return `Executor '${input.executorName}' exceeded ${input.limitExceeded.stream} output limit of ${input.limitExceeded.limitBytes} bytes; partial output was preserved.`;
}

function terminateChildWithFallback(
  child: ReturnType<typeof spawn>,
  forceKillTimeout: { value: ReturnType<typeof setTimeout> | undefined }
): void {
  child.kill("SIGTERM");
  if (!forceKillTimeout.value) {
    forceKillTimeout.value = setTimeout(() => {
      child.kill("SIGKILL");
    }, EXECUTOR_FORCE_KILL_GRACE_MS);
    forceKillTimeout.value.unref();
  }
}

function clearTimer(timer: { value: ReturnType<typeof setTimeout> | undefined }): void {
  if (timer.value) {
    clearTimeout(timer.value);
    timer.value = undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function executorHeartbeatPath(stdoutPath: string): string {
  return join(dirname(stdoutPath), "heartbeat.json");
}

function startExecutorHeartbeat(options: { path: string; pid: number | null; intervalMs?: number }): {
  markStdout: () => void;
  markStderr: () => void;
  finish: (patch: Partial<Pick<ExecutorHeartbeatState, "status" | "finishedAt" | "exitCode" | "timedOut" | "error">>) => Promise<void>;
} {
  const now = new Date().toISOString();
  let state: ExecutorHeartbeatState = {
    status: "running",
    pid: options.pid,
    startedAt: now,
    lastHeartbeatAt: now,
    lastStdoutAt: null,
    lastStderrAt: null,
    finishedAt: null,
    exitCode: null,
    timedOut: null,
    error: null
  };
  let writeChain = Promise.resolve();
  const write = (patch: Partial<ExecutorHeartbeatState>): Promise<void> => {
    state = { ...state, ...patch };
    writeChain = writeChain
      .catch(() => undefined)
      .then(() => writeJsonFile(options.path, state));
    return writeChain;
  };
  const intervalMs = options.intervalMs ?? DEFAULT_EXECUTOR_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimer =
    intervalMs > 0
      ? setInterval(() => {
          void write({ lastHeartbeatAt: new Date().toISOString() });
        }, intervalMs)
      : undefined;
  heartbeatTimer?.unref();
  void write({});
  return {
    markStdout: () => {
      void write({ lastHeartbeatAt: new Date().toISOString(), lastStdoutAt: new Date().toISOString() });
    },
    markStderr: () => {
      void write({ lastHeartbeatAt: new Date().toISOString(), lastStderrAt: new Date().toISOString() });
    },
    finish: async (patch) => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      await write({ lastHeartbeatAt: new Date().toISOString(), ...patch });
    }
  };
}

function outputLimitMarker(streamName: "stdout" | "stderr", limitBytes: number): string {
  return `\n[planweave: ${streamName} output truncated after ${limitBytes} bytes; executor terminated]\n`;
}

export async function readBoundedTextFile(path: string, limitBytes: number): Promise<{ text: string; truncated: boolean }> {
  const file = await open(path, "r");
  try {
    const stats = await file.stat();
    const bytesToRead = Math.min(stats.size, limitBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (stats.size <= limitBytes) {
      return { text, truncated: false };
    }
    return { text: `${text}\n[planweave: output summary truncated after ${limitBytes} bytes]\n`, truncated: true };
  } finally {
    await file.close();
  }
}

export function workspaceExecutorEnv(workspace: Pick<ProjectWorkspace, "planweaveHome">, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...(env ?? {}),
    PLANWEAVE_HOME: workspace.planweaveHome
  };
}

export function workspaceExecutionCwd(workspace: Pick<ProjectWorkspace, "rootPath" | "sourceRoot">): string {
  return workspace.sourceRoot ?? workspace.rootPath;
}

export async function pathExists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

export async function nextRunId(runRoot: string): Promise<string> {
  const entries = await optionalReaddir(runRoot, { withFileTypes: true });
  const count = entries?.filter((entry) => entry.isDirectory() && /^RUN-\d+$/.test(entry.name)).length ?? 0;
  return `RUN-${String(count + 1).padStart(3, "0")}`;
}

export async function prepareBlockRun(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  executorName: string;
  profile: ExecutorProfile;
  prompt: string;
}): Promise<{ runId: string; runDir: string; promptPath: string; metadataPath: string; startedAt: string }> {
  const { workspace } = await loadPackage(options.projectRoot);
  const { taskId, blockId } = parseBlockRef(options.claim.ref);
  const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
  const runId = await nextRunId(runRoot);
  const runDir = join(runRoot, runId);
  const promptPath = join(runDir, "prompt.md");
  const metadataPath = join(runDir, "metadata.json");
  const startedAt = new Date().toISOString();
  await mkdir(runDir, { recursive: true });
  await writeFile(promptPath, options.prompt, "utf8");
  await writeJsonFile(metadataPath, {
    runId,
    ref: options.claim.ref,
    executor: options.executorName,
    adapter: options.profile.adapter,
    projectRoot: workspace.rootPath,
    executionCwd: workspaceExecutionCwd(workspace),
    startedAt,
    finishedAt: null,
    exitCode: null,
    agentSessionId: null,
    codexSessionId: null
  });
  return { runId, runDir, promptPath, metadataPath, startedAt };
}

export async function finishRunMetadata(path: string, patch: Record<string, unknown>): Promise<void> {
  let previous: Record<string, unknown> = {};
  if (await pathExists(path)) {
    previous = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  }
  await writeJsonFile(path, { ...previous, ...patch });
}

export async function execWithStdin(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}): Promise<StdinCommandResult> {
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_EXECUTOR_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_EXECUTOR_MAX_STDERR_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const forceKillTimeout: { value: ReturnType<typeof setTimeout> | undefined } = { value: undefined };
    const runtimeTimeout: { value: ReturnType<typeof setTimeout> | undefined } = { value: undefined };
    let settled = false;
    let limitExceeded: ExecutorOutputLimitExceeded | undefined;

    const terminateChild = (): void => {
      terminateChildWithFallback(child, forceKillTimeout);
    };

    const writeBoundedOutput = (streamName: "stdout" | "stderr", chunk: Buffer): void => {
      if (limitExceeded) {
        return;
      }
      const currentBytes = streamName === "stdout" ? stdoutBytes : stderrBytes;
      const limitBytes = streamName === "stdout" ? maxStdoutBytes : maxStderrBytes;
      const remainingBytes = limitBytes - currentBytes;
      const allowedChunk = remainingBytes > 0 ? chunk.subarray(0, remainingBytes) : Buffer.alloc(0);
      if (allowedChunk.length > 0) {
        const allowedText = allowedChunk.toString("utf8");
        if (streamName === "stdout") {
          stdout += allowedText;
          stdoutBytes += allowedChunk.length;
        } else {
          stderr += allowedText;
          stderrBytes += allowedChunk.length;
        }
      }
      if (currentBytes + chunk.length <= limitBytes) {
        return;
      }
      const marker = outputLimitMarker(streamName, limitBytes);
      if (streamName === "stdout") {
        stdout += marker;
      } else {
        stderr += marker;
      }
      limitExceeded = { stream: streamName, limitBytes };
      terminateChild();
    };

    const settleReject = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      clearTimer(runtimeTimeout);
      clearTimer(forceKillTimeout);
      terminateChild();
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => writeBoundedOutput("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => writeBoundedOutput("stderr", chunk));
    child.stdout.on("error", settleReject);
    child.stderr.on("error", settleReject);
    child.stdin.on("error", settleReject);
    child.on("error", settleReject);
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateChild();
      }, options.timeoutMs);
      runtimeTimeout.value = timeout;
    }
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      clearTimer(runtimeTimeout);
      clearTimer(forceKillTimeout);
      if (settled) {
        return;
      }
      settled = true;
      resolve({ stdout, stderr, exitCode: limitExceeded ? 1 : timedOut ? 124 : code ?? 1, timedOut, limitExceeded });
    });
    try {
      child.stdin.end(options.stdin);
    } catch (error) {
      settleReject(error);
    }
  });
}

function finishWriteStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

export async function execWithStreaming(options: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  heartbeatIntervalMs?: number;
  tmux?: TmuxSessionInfo | null;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
}): Promise<StreamingCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_EXECUTOR_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_EXECUTOR_MAX_STDERR_BYTES;
  if (options.tmux) {
    const result = await runCommandInTmux({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      stdin: options.stdin,
      env: options.env,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      tmux: options.tmux,
      onStdout: options.onStdout,
      onStderr: options.onStderr
    });
    const [stdout, stderr] = await Promise.all([readBoundedTextFile(result.stdoutPath, maxStdoutBytes), readBoundedTextFile(result.stderrPath, maxStderrBytes)]);
    const limitExceeded =
      result.limitExceeded ??
      (stdout.truncated ? { stream: "stdout" as const, limitBytes: maxStdoutBytes } : stderr.truncated ? { stream: "stderr" as const, limitBytes: maxStderrBytes } : undefined);
    return { ...result, stdout: stdout.text, stderr: stderr.text, exitCode: limitExceeded ? 1 : result.exitCode, limitExceeded };
  }
  await mkdir(dirname(options.stdoutPath), { recursive: true });
  await mkdir(dirname(options.stderrPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const stdoutStream = createWriteStream(options.stdoutPath, { flags: "w" });
    const stderrStream = createWriteStream(options.stderrPath, { flags: "w" });
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const heartbeat = startExecutorHeartbeat({
      path: executorHeartbeatPath(options.stdoutPath),
      pid: child.pid ?? null,
      intervalMs: options.heartbeatIntervalMs
    });
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const forceKillTimeout: { value: ReturnType<typeof setTimeout> | undefined } = { value: undefined };
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let streamsClosed = false;
    let callbackError: unknown;
    let limitExceeded: ExecutorOutputLimitExceeded | undefined;
    let callbackChain = Promise.resolve();

    const closeStreams = (): void => {
      if (streamsClosed) {
        return;
      }
      streamsClosed = true;
      stdoutStream.destroy();
      stderrStream.destroy();
    };

    const terminateChild = (): void => {
      terminateChildWithFallback(child, forceKillTimeout);
    };

    const settleReject = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      terminateChild();
      closeStreams();
      void heartbeat.finish({
        status: "failed",
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        timedOut,
        error: errorText(error)
      });
      reject(error);
    };

    const enqueueCallback = (callback: ((chunk: string) => void | Promise<void>) | undefined, chunk: string): void => {
      if (!callback) {
        return;
      }
      callbackChain = callbackChain.then(() => callback(chunk)).catch((error: unknown) => {
        callbackError = error;
        terminateChild();
      });
    };

    const writeBoundedOutput = (streamName: "stdout" | "stderr", chunk: Buffer): void => {
      if (limitExceeded) {
        return;
      }
      const stream = streamName === "stdout" ? stdoutStream : stderrStream;
      const currentBytes = streamName === "stdout" ? stdoutBytes : stderrBytes;
      const limitBytes = streamName === "stdout" ? maxStdoutBytes : maxStderrBytes;
      const remainingBytes = limitBytes - currentBytes;
      const allowedChunk = remainingBytes > 0 ? chunk.subarray(0, remainingBytes) : Buffer.alloc(0);
      if (allowedChunk.length > 0) {
        if (streamName === "stdout") {
          heartbeat.markStdout();
        } else {
          heartbeat.markStderr();
        }
        const allowedText = allowedChunk.toString("utf8");
        if (streamName === "stdout") {
          stdout += allowedText;
          stdoutBytes += allowedChunk.length;
        } else {
          stderr += allowedText;
          stderrBytes += allowedChunk.length;
        }
        if (!stream.write(allowedChunk)) {
          const readable = streamName === "stdout" ? child.stdout : child.stderr;
          readable.pause();
          stream.once("drain", () => readable.resume());
        }
      }
      if (currentBytes + chunk.length <= limitBytes) {
        enqueueCallback(streamName === "stdout" ? options.onStdout : options.onStderr, chunk.toString("utf8"));
        return;
      }
      const marker = outputLimitMarker(streamName, limitBytes);
      stream.write(marker);
      if (streamName === "stdout") {
        stdout += marker;
      } else {
        stderr += marker;
      }
      limitExceeded = { stream: streamName, limitBytes };
      terminateChild();
    };

    stdoutStream.on("error", settleReject);
    stderrStream.on("error", settleReject);
    child.stdout.on("data", (chunk: Buffer) => writeBoundedOutput("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => writeBoundedOutput("stderr", chunk));
    child.on("error", settleReject);
    child.stdin.on("error", settleReject);
    if (timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateChild();
      }, timeoutMs);
    }
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      clearTimer(forceKillTimeout);
      if (settled) {
        return;
      }
      settled = true;
      Promise.all([finishWriteStream(stdoutStream), finishWriteStream(stderrStream), callbackChain])
        .then(async () => {
          await heartbeat.finish({
            status: callbackError ? "failed" : "finished",
            finishedAt: new Date().toISOString(),
            exitCode: callbackError || limitExceeded ? 1 : timedOut ? 124 : code ?? 1,
            timedOut,
            error: callbackError ? errorText(callbackError) : null
          });
        })
        .then(() => {
          if (callbackError) {
            reject(callbackError);
            return;
          }
          resolve({
            stdoutPath: options.stdoutPath,
            stderrPath: options.stderrPath,
            stdout,
            stderr,
            exitCode: limitExceeded ? 1 : timedOut ? 124 : code ?? 1,
            timedOut,
            limitExceeded
          });
        })
        .catch(reject);
    });
    try {
      child.stdin.end(options.stdin);
    } catch (error) {
      settleReject(error);
    }
  });
}
