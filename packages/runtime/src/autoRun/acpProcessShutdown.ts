import { ACP_FORCE_EXIT_CONFIRM_WINDOW_MS, type AcpShutdownPolicy } from "../acpProfile/schema.js";
import type {
  ManagedProcessTree,
  ProcessTerminationOptions
} from "../process/managedProcessTree.js";
import type { AcpCleanupDeadline } from "./acpExecutionCleanup.js";

export type AcpProcessShutdownOptions = {
  policy: AcpShutdownPolicy;
  deadline: AcpCleanupDeadline;
  closeInput(): void;
  waitForRootExit(timeoutMs: number): Promise<boolean>;
  processTree: ManagedProcessTree;
  cleanupExitedProcessTree?: (termination: ProcessTerminationOptions) => Promise<void>;
};

export async function shutdownAcpProcess(options: AcpProcessShutdownOptions): Promise<void> {
  options.closeInput();
  const exitedAfterEof = await options.waitForRootExit(
    Math.min(options.policy.eofDrainMs, options.deadline.remainingMs())
  );
  const remainingMs = options.deadline.remainingMs();
  // Graceful termination keeps its declared share first; the confirmation window takes what
  // is left. Reserving the window first would starve grace whenever a profile asks for a
  // teardown budget smaller than the window, and the process would never see its SIGTERM.
  const graceMs = Math.min(options.policy.terminateGraceMs, remainingMs);
  const forceExitConfirmMs = Math.min(
    ACP_FORCE_EXIT_CONFIRM_WINDOW_MS,
    Math.max(0, remainingMs - graceMs)
  );
  const reason = exitedAfterEof ? "acp-dispose-after-eof" : "acp-dispose";
  const termination = { graceMs, forceExitConfirmMs, deadline: options.deadline };
  const results = await Promise.allSettled([
    options.processTree.terminate(reason, termination),
    options.cleanupExitedProcessTree?.(termination) ?? Promise.resolve()
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (options.deadline.remainingMs() <= 0) {
    failures.push(new Error("ACP process shutdown exceeded the configured cleanup deadline."));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "ACP process-tree cleanup failed.");
  }
}
