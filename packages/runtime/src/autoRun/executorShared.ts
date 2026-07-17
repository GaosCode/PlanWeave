import { createWriteStream, constants } from "node:fs";
import type { WriteStream } from "node:fs";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import {
  DEFAULT_PROCESS_TREE_GRACE_MS,
  spawnManagedProcess,
  type ManagedProcessTree
} from "../process/managedProcessTree.js";
import { isCommandTrusted, untrustedExecutorCommandError } from "../taskManager/hookTrustStore.js";
import type {
  ClaimResult,
  ExecutorIntegrationName,
  ExecutorProfile,
  PackageWorkspaceRef,
  ProjectWorkspace
} from "../types.js";
import type { ExecutionWaveId } from "./runnerContractSchemas.js";
import { runCommandInTmux, type TmuxSessionInfo } from "./tmuxExecutor.js";
import { recordBlockRunInIndex } from "./blockRunIndex.js";

export type BlockClaim = Extract<ClaimResult, { kind: "block" }>;
export type FeedbackClaim = Extract<ClaimResult, { kind: "feedback" }>;

export const DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_EXECUTOR_MAX_STDOUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_EXECUTOR_MAX_STDERR_BYTES = 2 * 1024 * 1024;
export const DEFAULT_EXECUTOR_HEARTBEAT_INTERVAL_MS = 5 * 1000;
/** @deprecated Prefer DEFAULT_PROCESS_TREE_GRACE_MS; kept as the executor-facing alias. */
export const EXECUTOR_FORCE_KILL_GRACE_MS = DEFAULT_PROCESS_TREE_GRACE_MS;

export class ExecutorCancelledError extends Error {
  constructor(message = "Executor cancelled.") {
    super(message);
    this.name = "AbortError";
  }
}

export function isExecutorCancelledError(error: unknown): error is ExecutorCancelledError {
  return error instanceof ExecutorCancelledError;
}

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

export function executorRuntimeLimits(
  profile: Pick<ExecutorProfile, "adapter"> & Partial<ExecutorRuntimeLimits>
): ExecutorRuntimeLimits {
  return {
    timeoutMs: profile.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS,
    maxStdoutBytes: profile.maxStdoutBytes ?? DEFAULT_EXECUTOR_MAX_STDOUT_BYTES,
    maxStderrBytes: profile.maxStderrBytes ?? DEFAULT_EXECUTOR_MAX_STDERR_BYTES
  };
}

/** Gate package-authored executor commands; builtin adapter profiles stay ungated. */
export async function assertPackageExecutorCommandTrusted(options: {
  projectRoot: PackageWorkspaceRef;
  executorName: string;
  profile: ExecutorProfile & { source?: "builtin" | "package" };
}): Promise<void> {
  if (options.profile.source !== "package") {
    return;
  }
  if (options.profile.adapter === "manual" || !("command" in options.profile)) {
    return;
  }
  if (
    !(await isCommandTrusted(options.projectRoot, options.profile.command, options.profile.args))
  ) {
    throw untrustedExecutorCommandError(options.profile.command, options.executorName);
  }
}

export function executorLimitFailureMessage(input: {
  executorName: string;
  limitExceeded: ExecutorOutputLimitExceeded;
}): string {
  return `Executor '${input.executorName}' exceeded ${input.limitExceeded.stream} output limit of ${input.limitExceeded.limitBytes} bytes; partial output was preserved.`;
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

/** Attach process-tree termination failure while preserving the primary timeout/limit/cancel error. */
export function withProcessTreeTerminationCause(primary: Error, terminationError: unknown): Error {
  const termMessage = errorText(terminationError);
  const combined = new Error(
    `${primary.message} (process tree termination failed: ${termMessage})`,
    {
      cause: terminationError
    }
  );
  combined.name = primary.name;
  return combined;
}

/**
 * Tracks a single tree.terminate() promise for an executor invocation.
 * Callers must await completion before finishing heartbeat/streams or resolving/rejecting.
 */
function createExecutorTermination(tree: ManagedProcessTree): {
  readonly started: boolean;
  start(reason: string): void;
  awaitIfStarted(): Promise<void>;
} {
  let promise: Promise<void> | undefined;
  return {
    get started() {
      return promise !== undefined;
    },
    start(reason: string): void {
      if (promise) {
        return;
      }
      // Share one terminate promise; rejections stay on the promise for awaitIfStarted.
      promise = tree.terminate(reason).then(() => undefined);
    },
    async awaitIfStarted(): Promise<void> {
      if (promise) {
        await promise;
      }
    }
  };
}

export function executorHeartbeatPath(stdoutPath: string): string {
  return join(dirname(stdoutPath), "heartbeat.json");
}

function startExecutorHeartbeat(options: {
  path: string;
  pid: number | null;
  intervalMs?: number;
}): {
  markStdout: () => void;
  markStderr: () => void;
  finish: (
    patch: Partial<
      Pick<ExecutorHeartbeatState, "status" | "finishedAt" | "exitCode" | "timedOut" | "error">
    >
  ) => Promise<void>;
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
    writeChain = writeChain.catch(() => undefined).then(() => writeJsonFile(options.path, state));
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
      void write({
        lastHeartbeatAt: new Date().toISOString(),
        lastStdoutAt: new Date().toISOString()
      });
    },
    markStderr: () => {
      void write({
        lastHeartbeatAt: new Date().toISOString(),
        lastStderrAt: new Date().toISOString()
      });
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

export async function readBoundedTextFile(
  path: string,
  limitBytes: number
): Promise<{ text: string; truncated: boolean }> {
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
    return {
      text: `${text}\n[planweave: output summary truncated after ${limitBytes} bytes]\n`,
      truncated: true
    };
  } finally {
    await file.close();
  }
}

export function workspaceExecutorEnv(
  workspace: Pick<ProjectWorkspace, "planweaveHome">,
  env?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...(env ?? {}),
    PLANWEAVE_HOME: workspace.planweaveHome
  };
}

export function workspaceExecutionCwd(
  workspace: Pick<ProjectWorkspace, "rootPath" | "sourceRoot">
): string {
  return workspace.sourceRoot ?? workspace.rootPath;
}

export async function pathExists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

/** @deprecated Prefer `allocateRunId` — kept as a thin alias for callers/tests. */
export async function nextRunId(runRoot: string): Promise<string> {
  return allocateRunId(runRoot);
}

/** Reserve a RUN-* directory atomically via exclusive mkdir. */
export async function allocateRunId(runRoot: string): Promise<string> {
  await mkdir(runRoot, { recursive: true });
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const existing = await optionalReaddir(runRoot, { withFileTypes: true });
    const count =
      existing?.filter((entry) => entry.isDirectory() && /^RUN-\d+$/.test(entry.name)).length ?? 0;
    const candidate = `RUN-${String(count + attempt).padStart(3, "0")}`;
    try {
      await mkdir(join(runRoot, candidate), { recursive: false });
      return candidate;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unable to allocate a run id under ${runRoot}`);
}

export async function prepareBlockRun(options: {
  projectRoot: PackageWorkspaceRef;
  claim: BlockClaim;
  executorName: string;
  adapter: ExecutorIntegrationName;
  profile: ExecutorProfile;
  prompt: string;
  executionWaveId?: ExecutionWaveId;
}): Promise<{
  runId: string;
  runDir: string;
  promptPath: string;
  metadataPath: string;
  startedAt: string;
}> {
  const { workspace } = await loadPackage(options.projectRoot);
  const { taskId, blockId } = parseBlockRef(options.claim.ref);
  const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
  const runId = await allocateRunId(runRoot);
  const runDir = join(runRoot, runId);
  const promptPath = join(runDir, "prompt.md");
  const metadataPath = join(runDir, "metadata.json");
  const startedAt = new Date().toISOString();
  await writeFile(promptPath, options.prompt, "utf8");
  await writeJsonFile(metadataPath, {
    runId,
    ref: options.claim.ref,
    taskId,
    blockId,
    executor: options.executorName,
    adapter: options.adapter,
    agentId: options.profile.adapter === "agent" ? options.profile.agent : null,
    runnerKind: options.profile.adapter === "agent" ? options.profile.runner.transport : null,
    projectRoot: workspace.rootPath,
    executionCwd: workspaceExecutionCwd(workspace),
    startedAt,
    ...(options.executionWaveId ? { executionWaveId: options.executionWaveId } : {}),
    finishedAt: null,
    exitCode: null,
    agentSessionId: null,
    codexSessionId: null
  });
  await recordBlockRunInIndex(runRoot, runId);
  return { runId, runDir, promptPath, metadataPath, startedAt };
}

export async function finishRunMetadata(
  path: string,
  patch: Record<string, unknown>
): Promise<void> {
  let previous: Record<string, unknown> = {};
  if (await pathExists(path)) {
    previous = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  }
  await writeJsonFile(path, { ...previous, ...patch });
}

export type ExecutorAttemptOutcome = "succeeded" | "failed" | "cancelled";

export async function finalizeExecutorAttemptMetadata(options: {
  path: string;
  outcome: ExecutorAttemptOutcome;
  exitCode: number;
  timedOut: boolean;
  failureReason: string | null;
  patch?: Record<string, unknown>;
}): Promise<void> {
  const cancelled = options.outcome === "cancelled";
  await finishRunMetadata(options.path, {
    ...options.patch,
    finishedAt: new Date().toISOString(),
    exitCode: options.exitCode,
    outcome: options.outcome,
    cancelled,
    stopped: cancelled,
    timedOut: options.timedOut,
    failureReason: options.failureReason
  });
}

export async function finalizeExecutorCancellationOnError<T>(options: {
  path: string;
  run: () => Promise<T>;
  patch?: Record<string, unknown>;
}): Promise<T> {
  try {
    return await options.run();
  } catch (error) {
    if (isExecutorCancelledError(error)) {
      await finalizeExecutorAttemptMetadata({
        path: options.path,
        outcome: "cancelled",
        exitCode: 130,
        timedOut: false,
        failureReason: error.message,
        patch: options.patch
      });
    }
    throw error;
  }
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
    const { child, tree } = spawnManagedProcess({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      graceMs: EXECUTOR_FORCE_KILL_GRACE_MS
    });
    const termination = createExecutorTermination(tree);
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const runtimeTimeout: { value: ReturnType<typeof setTimeout> | undefined } = {
      value: undefined
    };
    let settled = false;
    let settling = false;
    let limitExceeded: ExecutorOutputLimitExceeded | undefined;
    let closeCode: number | null = null;

    const clearSettlementTimers = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      clearTimer(runtimeTimeout);
    };

    const buildResult = (): StdinCommandResult => ({
      stdout,
      stderr,
      exitCode: limitExceeded ? 1 : timedOut ? 124 : (closeCode ?? 1),
      timedOut,
      limitExceeded
    });

    const primaryTerminationError = (fallbackMessage: string): Error => {
      if (timedOut) {
        return new Error(
          `Executor timed out after ${String(options.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS)}ms.`
        );
      }
      if (limitExceeded) {
        return new Error(
          executorLimitFailureMessage({ executorName: "execWithStdin", limitExceeded })
        );
      }
      return new Error(fallbackMessage);
    };

    const settleWithTermination = (work: () => void | Promise<void>): void => {
      if (settled || settling) {
        return;
      }
      settling = true;
      clearSettlementTimers();
      void (async () => {
        try {
          await termination.awaitIfStarted();
          if (settled) {
            return;
          }
          settled = true;
          await work();
        } catch (terminationError) {
          if (settled) {
            return;
          }
          settled = true;
          const primary = primaryTerminationError("Managed process tree termination failed.");
          reject(withProcessTreeTerminationCause(primary, terminationError));
        }
      })();
    };

    const settleReject = (error: unknown): void => {
      if (settled || settling) {
        return;
      }
      termination.start("error");
      settleWithTermination(() => {
        reject(error);
      });
    };

    const writeBoundedOutput = (streamName: "stdout" | "stderr", chunk: Buffer): void => {
      if (limitExceeded || settled || settling) {
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
      termination.start(`${streamName}-limit`);
      settleWithTermination(() => {
        resolve(buildResult());
      });
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
        termination.start("timeout");
        settleWithTermination(() => {
          resolve(buildResult());
        });
      }, options.timeoutMs);
      runtimeTimeout.value = timeout;
    }
    child.on("close", (code) => {
      closeCode = code;
      if (settled || settling) {
        return;
      }
      // Normal exit (no timeout/limit/cancel termination): settle immediately.
      // Forced paths settle only after termination promise completes.
      if (termination.started) {
        settleWithTermination(() => {
          resolve(buildResult());
        });
        return;
      }
      settleWithTermination(() => {
        resolve(buildResult());
      });
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
  signal?: AbortSignal;
}): Promise<StreamingCommandResult> {
  if (options.signal?.aborted) {
    throw new ExecutorCancelledError();
  }
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
      onStderr: options.onStderr,
      signal: options.signal
    });
    if (options.signal?.aborted) {
      throw new ExecutorCancelledError();
    }
    const [stdout, stderr] = await Promise.all([
      readBoundedTextFile(result.stdoutPath, maxStdoutBytes),
      readBoundedTextFile(result.stderrPath, maxStderrBytes)
    ]);
    const limitExceeded =
      result.limitExceeded ??
      (stdout.truncated
        ? { stream: "stdout" as const, limitBytes: maxStdoutBytes }
        : stderr.truncated
          ? { stream: "stderr" as const, limitBytes: maxStderrBytes }
          : undefined);
    return {
      ...result,
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: limitExceeded ? 1 : result.exitCode,
      limitExceeded
    };
  }
  await mkdir(dirname(options.stdoutPath), { recursive: true });
  await mkdir(dirname(options.stderrPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const stdoutStream = createWriteStream(options.stdoutPath, { flags: "w" });
    const stderrStream = createWriteStream(options.stderrPath, { flags: "w" });
    const { child, tree } = spawnManagedProcess({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      graceMs: EXECUTOR_FORCE_KILL_GRACE_MS
    });
    const termination = createExecutorTermination(tree);
    const heartbeat = startExecutorHeartbeat({
      path: executorHeartbeatPath(options.stdoutPath),
      pid: child.pid ?? null,
      intervalMs: options.heartbeatIntervalMs
    });
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let settling = false;
    let streamsClosed = false;
    let callbackError: unknown;
    let limitExceeded: ExecutorOutputLimitExceeded | undefined;
    let callbackChain = Promise.resolve();
    let closeCode: number | null = null;

    const closeStreams = (): void => {
      if (streamsClosed) {
        return;
      }
      streamsClosed = true;
      stdoutStream.destroy();
      stderrStream.destroy();
    };

    const clearSettlementTimers = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };

    const buildResult = (): StreamingCommandResult => ({
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
      stdout,
      stderr,
      exitCode: limitExceeded ? 1 : timedOut ? 124 : (closeCode ?? 1),
      timedOut,
      limitExceeded
    });

    const primaryTerminationError = (fallbackMessage: string): Error => {
      if (callbackError instanceof Error) {
        return callbackError;
      }
      if (callbackError !== undefined) {
        return new Error(errorText(callbackError));
      }
      if (options.signal?.aborted) {
        return new ExecutorCancelledError();
      }
      if (timedOut) {
        return new Error(`Executor timed out after ${String(timeoutMs)}ms.`);
      }
      if (limitExceeded) {
        return new Error(
          executorLimitFailureMessage({ executorName: "execWithStreaming", limitExceeded })
        );
      }
      return new Error(fallbackMessage);
    };

    const finishStreamsAndHeartbeat = async (
      getOutcome: () => {
        status: "finished" | "failed";
        exitCode: number;
        error: string | null;
      }
    ): Promise<void> => {
      if (!streamsClosed) {
        await Promise.all([
          finishWriteStream(stdoutStream),
          finishWriteStream(stderrStream),
          callbackChain
        ]);
      } else {
        await callbackChain.catch(() => undefined);
      }
      const outcome = getOutcome();
      await heartbeat.finish({
        status: outcome.status,
        finishedAt: new Date().toISOString(),
        exitCode: outcome.exitCode,
        timedOut,
        error: outcome.error
      });
    };

    const settleWithTermination = (work: () => void | Promise<void>): void => {
      if (settled || settling) {
        return;
      }
      settling = true;
      clearSettlementTimers();
      options.signal?.removeEventListener("abort", onAbort);
      void (async () => {
        // Termination await and finalization work fail independently.
        // `settled` means the outer promise was resolve/reject'd (or is about to be).
        try {
          // Complete grace→force (and confirm tree exit) before heartbeat finish / resolve.
          await termination.awaitIfStarted();
        } catch (terminationError) {
          if (settled) {
            return;
          }
          settled = true;
          const primary = primaryTerminationError("Managed process tree termination failed.");
          const combined = withProcessTreeTerminationCause(primary, terminationError);
          closeStreams();
          try {
            await heartbeat.finish({
              status: "failed",
              finishedAt: new Date().toISOString(),
              exitCode: 1,
              timedOut,
              error: errorText(combined)
            });
          } catch {
            // Heartbeat write failure must not hide the termination failure.
          }
          reject(combined);
          return;
        }

        if (settled) {
          return;
        }

        try {
          await work();
          settled = true;
        } catch (finalizationError) {
          if (settled) {
            return;
          }
          settled = true;
          closeStreams();
          try {
            await heartbeat.finish({
              status: "failed",
              finishedAt: new Date().toISOString(),
              exitCode: 1,
              timedOut,
              error: errorText(finalizationError)
            });
          } catch {
            // Best-effort heartbeat after stream/finalization failure.
          }
          reject(finalizationError);
        }
      })();
    };

    const onAbort = (): void => {
      termination.start("abort");
      settleWithTermination(async () => {
        closeStreams();
        await finishStreamsAndHeartbeat(() => ({
          status: "failed",
          exitCode: 1,
          error: errorText(new ExecutorCancelledError())
        }));
        reject(new ExecutorCancelledError());
      });
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const settleReject = (error: unknown): void => {
      if (settled || settling) {
        return;
      }
      termination.start("error");
      settleWithTermination(async () => {
        closeStreams();
        await finishStreamsAndHeartbeat(() => ({
          status: "failed",
          exitCode: 1,
          error: errorText(error)
        }));
        reject(error);
      });
    };

    const enqueueCallback = (
      callback: ((chunk: string) => void | Promise<void>) | undefined,
      chunk: string
    ): void => {
      if (!callback) {
        return;
      }
      callbackChain = callbackChain
        .then(() => callback(chunk))
        .catch((error: unknown) => {
          // Always record the first callback failure so normal-close finalization can
          // reject even when settlement already started (child exited before the async callback).
          // Higher-priority timeout/cancel/limit paths intentionally ignore callbackError.
          if (callbackError === undefined) {
            callbackError = error;
          }
          if (settled || settling) {
            return;
          }
          termination.start("callback-error");
          settleWithTermination(async () => {
            closeStreams();
            await finishStreamsAndHeartbeat(() => ({
              status: "failed",
              exitCode: 1,
              error: errorText(error)
            }));
            reject(error);
          });
        });
    };

    const writeBoundedOutput = (streamName: "stdout" | "stderr", chunk: Buffer): void => {
      if (limitExceeded || settled || settling) {
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
        enqueueCallback(
          streamName === "stdout" ? options.onStdout : options.onStderr,
          chunk.toString("utf8")
        );
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
      termination.start(`${streamName}-limit`);
      settleWithTermination(async () => {
        await finishStreamsAndHeartbeat(() => ({
          status: "finished",
          exitCode: 1,
          error: null
        }));
        resolve(buildResult());
      });
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
        termination.start("timeout");
        settleWithTermination(async () => {
          await finishStreamsAndHeartbeat(() => ({
            status: "finished",
            exitCode: 124,
            error: null
          }));
          if (options.signal?.aborted) {
            reject(new ExecutorCancelledError());
            return;
          }
          resolve(buildResult());
        });
      }, timeoutMs);
    }
    child.on("close", (code) => {
      closeCode = code;
      if (settled || settling) {
        return;
      }
      // Normal exit, or late close after termination was already requested elsewhere.
      settleWithTermination(async () => {
        await finishStreamsAndHeartbeat(() => ({
          status: callbackError ? "failed" : "finished",
          exitCode: callbackError || limitExceeded ? 1 : timedOut ? 124 : (code ?? 1),
          error: callbackError ? errorText(callbackError) : null
        }));
        if (callbackError) {
          reject(callbackError);
          return;
        }
        if (options.signal?.aborted) {
          reject(new ExecutorCancelledError());
          return;
        }
        resolve(buildResult());
      });
    });
    try {
      child.stdin.end(options.stdin);
    } catch (error) {
      settleReject(error);
    }
  });
}
