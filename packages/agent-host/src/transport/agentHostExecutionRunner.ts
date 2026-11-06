import { performance } from "node:perf_hooks";
import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import {
  AgentHostSessionLoadError,
  type AgentHostExecutionContext
} from "../execution/agentHostExecutor.js";
import { parseAgentHostDispatchResult } from "../protocol.js";
import type { HttpArtifactClient } from "../artifacts/httpArtifactTransfer.js";
import type { AgentHostExecution, AgentHostExecutionSettlement } from "../state/agentHostState.js";
import type { AgentHostClientOptions } from "./agentHostClientOptions.js";
import { executionFailure, executionCleanupFailed } from "./agentHostExecutionOutcome.js";

export type ActiveExecution = {
  execution: AgentHostExecution;
  controller: AbortController;
  sessionStart: AgentHostExecutionContext["sessionStart"];
  cleanupTimer?: unknown;
  cleanupFailed: boolean;
  cancellationStartedAt?: number;
  cleanupComplete?: boolean;
  cleanupDeadline?: Exclude<
    Parameters<NonNullable<AgentHostExecutionContext["cleanupObserver"]>>[0],
    null
  >;
};

export async function runHostExecution(input: {
  active: ActiveExecution;
  options: AgentHostClientOptions;
  artifacts: HttpArtifactClient;
  now(): Date;
  checkLeases(): boolean;
  stopped(): boolean;
  persistenceFailed(): boolean;
  failProtection(reason: string): void;
  observeCleanup(
    active: ActiveExecution,
    deadline: Parameters<NonNullable<AgentHostExecutionContext["cleanupObserver"]>>[0]
  ): void;
}): Promise<void> {
  const active = input.active;
  const { execution, controller, sessionStart } = active;
  const command = execution.command;
  if (command.protocolVersion !== agentHostProtocolVersion) {
    input.failProtection("stored_execution_protocol_incompatible");
    return;
  }
  try {
    let outcome:
      | { kind: "completed"; result: ReturnType<typeof parseAgentHostDispatchResult> }
      | { kind: "failed"; error: unknown };
    try {
      if (!input.checkLeases() || controller.signal.aborted) return;
      if (
        execution.command.envelope.restoration &&
        execution.command.envelope.restoration.hostId !== input.options.hostId
      )
        throw new Error("acp_restore_host_changed");
      if (
        execution.command.envelope.restoration &&
        input.options.conversations?.isSessionActive(
          execution.command.envelope.restoration.sessionId
        )
      )
        throw new Error("acp_conversation_turn_in_flight");
      outcome = {
        kind: "completed",
        result: parseAgentHostDispatchResult(
          await input.options.executor.execute(command, {
            signal: controller.signal,
            get cancellationStartedAt() {
              return active.cancellationStartedAt;
            },
            cleanupObserver: (deadline) => input.observeCleanup(active, deadline),
            executionKey: `${execution.command.dispatchId}:${execution.command.leaseId}:${execution.command.executionAttemptId}`,
            artifacts: input.artifacts.forExecution(
              command,
              (evidence) =>
                input.options.state.recordArtifactTransfer(
                  execution.sequence,
                  execution.command.leaseId,
                  evidence
                ),
              controller.signal
            ),
            sessionStart
          })
        )
      };
    } catch (error) {
      outcome = { kind: "failed", error };
    }
    if (outcome.kind === "failed" && executionCleanupFailed(outcome.error)) {
      active.cleanupFailed = true;
      input.failProtection("execution_cleanup_failed");
      return;
    }
    if ((!input.stopped() && !input.checkLeases()) || input.persistenceFailed()) return;
    let settlement: AgentHostExecutionSettlement;
    if (outcome.kind === "completed") {
      settlement = input.options.state.completeExecution(
        execution.sequence,
        execution.command,
        outcome.result,
        input.now()
      );
    } else if (
      outcome.error instanceof AgentHostSessionLoadError &&
      !controller.signal.aborted &&
      !execution.command.envelope.restoration
    ) {
      settlement = input.options.state.failResumption(
        execution.sequence,
        execution.command,
        input.now()
      );
    } else {
      settlement = input.options.state.failExecution(
        execution.sequence,
        execution.command,
        executionFailure(outcome.error, controller.signal.aborted),
        input.now()
      );
    }
    if (settlement !== "applied") controller.abort();
  } catch {
    input.failProtection("execution_persistence_failed");
  }
}

type CleanupProtectionInput = {
  clock: import("./hostTransport.js").HostTransportClock;
  isActive(active: ActiveExecution): boolean;
  failProtection(reason: string): void;
};
export function observeExecutionCleanup(
  input: CleanupProtectionInput,
  active: ActiveExecution,
  deadline: Parameters<NonNullable<AgentHostExecutionContext["cleanupObserver"]>>[0]
): void {
  if (!input.isActive(active)) return;
  if (active.cleanupTimer !== undefined) input.clock.clearTimeout(active.cleanupTimer);
  active.cleanupTimer = undefined;
  active.cleanupDeadline = deadline ?? undefined;
  active.cleanupComplete = deadline === null;
  if (deadline) armExecutionCleanup(input, active, deadline.remainingMs());
}

export function armExecutionCleanup(
  input: CleanupProtectionInput,
  active: ActiveExecution,
  timeoutMs: number
): void {
  if (active.cleanupComplete) return;
  active.cleanupTimer = input.clock.setTimeout(() => {
    active.cleanupTimer = undefined;
    if (!input.isActive(active)) return;
    input.failProtection("execution_cleanup_timeout");
  }, timeoutMs);
}

export function hostExecutionSessionBusy(
  activeExecutions: ReadonlyMap<number, ActiveExecution>,
  state: AgentHostClientOptions["state"],
  sequence: number,
  sessionId: string | undefined
): boolean {
  if (activeExecutions.has(sequence)) return true;
  if (!sessionId) return false;
  return [...activeExecutions.values()].some((active) => {
    const activeSessionId =
      active.sessionStart.kind === "load"
        ? active.sessionStart.sessionId
        : state.executionEvidence(active.execution.sequence)?.acpSessionId;
    return activeSessionId === sessionId;
  });
}

export function markExecutionCancellation(active: ActiveExecution): void {
  active.cancellationStartedAt ??= performance.now();
}
