import { z } from "zod";
import {
  DEFAULT_PROCESS_TREE_GRACE_MS,
  spawnManagedProcess
} from "../process/managedProcessTree.js";
import type {
  ManifestReviewBlock,
  ManifestTaskNode,
  ReviewHookOutput,
  ReviewResult
} from "../types.js";
import { isCommandTrusted, untrustedHookCommandError } from "./hookTrustStore.js";

export const REVIEW_HOOK_TIMEOUT_MS = 60_000;
export const REVIEW_HOOK_STDOUT_LIMIT_BYTES = 1_048_576;
export const REVIEW_HOOK_STDERR_LIMIT_BYTES = 1_048_576;
export const REVIEW_HOOK_FORCE_KILL_GRACE_MS = DEFAULT_PROCESS_TREE_GRACE_MS;

const reviewHookOutputSchema = z
  .object({
    action: z.literal("use_feedback"),
    feedbackPrompt: z.string().min(1)
  })
  .strict();

type ReviewHookProcessLimits = {
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
};

type ReviewHookProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  limits: ReviewHookProcessLimits;
};

function appendLimitedChunk(options: {
  chunks: Buffer[];
  currentBytes: number;
  chunk: Buffer | string;
  limitBytes: number;
}): { nextBytes: number; exceeded: boolean } {
  const buffer = Buffer.isBuffer(options.chunk) ? options.chunk : Buffer.from(options.chunk);
  const nextBytes = options.currentBytes + buffer.byteLength;
  if (nextBytes <= options.limitBytes) {
    options.chunks.push(buffer);
    return { nextBytes, exceeded: false };
  }
  const remainingBytes = options.limitBytes - options.currentBytes;
  if (remainingBytes > 0) {
    options.chunks.push(buffer.subarray(0, remainingBytes));
  }
  return { nextBytes, exceeded: true };
}

function withReviewHookTerminationCause(primary: Error, terminationError: unknown): Error {
  const termMessage =
    terminationError instanceof Error ? terminationError.message : String(terminationError);
  const combined = new Error(
    `${primary.message} (process tree termination failed: ${termMessage})`,
    {
      cause: terminationError
    }
  );
  combined.name = primary.name;
  return combined;
}

export async function runReviewHookProcess(options: ReviewHookProcessOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const { child, tree } = spawnManagedProcess({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      graceMs: REVIEW_HOOK_FORCE_KILL_GRACE_MS
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let settling = false;
    let terminationPromise: Promise<unknown> | undefined;

    const startTermination = (reason: string): void => {
      terminationPromise ??= tree.terminate(reason);
    };

    const settleAfterTermination = (kind: "resolve" | "reject", value: string | Error): void => {
      if (settled || settling) {
        return;
      }
      settling = true;
      clearTimeout(timer);
      void (async () => {
        try {
          if (terminationPromise) {
            await terminationPromise;
          }
          if (settled) {
            return;
          }
          settled = true;
          if (kind === "resolve") {
            resolve(typeof value === "string" ? value : value.message);
          } else {
            reject(value instanceof Error ? value : new Error(String(value)));
          }
        } catch (terminationError) {
          if (settled) {
            return;
          }
          settled = true;
          const primary =
            value instanceof Error
              ? value
              : new Error(typeof value === "string" ? value : String(value));
          // Keep the primary timeout/limit/cancel error and attach termination failure.
          reject(withReviewHookTerminationCause(primary, terminationError));
        }
      })();
    };

    const timer = setTimeout(() => {
      startTermination("timeout");
      settleAfterTermination(
        "reject",
        new Error(`Review hook timed out after ${options.limits.timeoutMs}ms.`)
      );
    }, options.limits.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled || settling) {
        return;
      }
      const result = appendLimitedChunk({
        chunks: stdoutChunks,
        currentBytes: stdoutBytes,
        chunk,
        limitBytes: options.limits.stdoutLimitBytes
      });
      stdoutBytes = result.nextBytes;
      if (result.exceeded) {
        startTermination("stdout-limit");
        settleAfterTermination(
          "reject",
          new Error(`Review hook stdout exceeded ${options.limits.stdoutLimitBytes} bytes.`)
        );
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      if (settled || settling) {
        return;
      }
      const result = appendLimitedChunk({
        chunks: stderrChunks,
        currentBytes: stderrBytes,
        chunk,
        limitBytes: options.limits.stderrLimitBytes
      });
      stderrBytes = result.nextBytes;
      if (result.exceeded) {
        startTermination("stderr-limit");
        settleAfterTermination(
          "reject",
          new Error(`Review hook stderr exceeded ${options.limits.stderrLimitBytes} bytes.`)
        );
      }
    });

    child.on("error", (error) => {
      settleAfterTermination("reject", error);
    });

    child.stdin.on("error", (error) => {
      startTermination("stdin-error");
      settleAfterTermination("reject", new Error(`Review hook stdin failed: ${error.message}`));
    });

    child.on("close", (code) => {
      if (settled || settling) {
        return;
      }
      if (code === 0) {
        settleAfterTermination("resolve", Buffer.concat(stdoutChunks).toString("utf8"));
        return;
      }
      if (stderrBytes > options.limits.stderrLimitBytes) {
        settleAfterTermination(
          "reject",
          new Error(`Review hook stderr exceeded ${options.limits.stderrLimitBytes} bytes.`)
        );
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      settleAfterTermination("reject", new Error(stderr || `hook exited with code ${code}`));
    });

    child.stdin.end(options.stdin);
  });
}

function parseReviewHookOutput(output: string): ReviewHookOutput {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Review hook returned invalid JSON: ${message}`);
  }

  const parsed = reviewHookOutputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `Review hook output schema invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  return parsed.data;
}

export async function executeReviewHook(options: {
  projectRoot: string;
  reviewBlock: ManifestReviewBlock;
  reviewResult: ReviewResult;
  task: ManifestTaskNode;
  reviewBlockRef: string;
  feedbackCycleCount: number;
}): Promise<ReviewHookOutput> {
  const hook = options.reviewBlock.review.hook;
  if (!hook) {
    return { action: "use_feedback", feedbackPrompt: options.reviewResult.content };
  }
  if (!(await isCommandTrusted(options.projectRoot, hook.command, hook.args))) {
    throw untrustedHookCommandError(hook.command, options.reviewBlockRef);
  }
  const input = JSON.stringify({
    reviewResult: options.reviewResult,
    task: { taskId: options.task.id, title: options.task.title },
    reviewBlockRef: options.reviewBlockRef,
    feedbackCycleCount: options.feedbackCycleCount
  });
  const output = await runReviewHookProcess({
    command: hook.command,
    args: hook.args,
    cwd: options.projectRoot,
    stdin: input,
    limits: {
      timeoutMs: REVIEW_HOOK_TIMEOUT_MS,
      stdoutLimitBytes: REVIEW_HOOK_STDOUT_LIMIT_BYTES,
      stderrLimitBytes: REVIEW_HOOK_STDERR_LIMIT_BYTES
    }
  });
  return parseReviewHookOutput(output);
}
