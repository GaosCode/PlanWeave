import { ACP_FORCE_EXIT_CONFIRM_MS, type AcpShutdownPolicy } from "../acpProfile/schema.js";
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
  const forceExitConfirmMs = Math.min(ACP_FORCE_EXIT_CONFIRM_MS, options.deadline.remainingMs());
  const graceMs = Math.min(
    options.policy.terminateGraceMs,
    Math.max(0, options.deadline.remainingMs() - forceExitConfirmMs)
  );
  const reason = exitedAfterEof ? "acp-dispose-after-eof" : "acp-dispose";
  const termination = { graceMs, forceExitConfirmMs };
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
