import type { RemoteBlockDispatchCandidate, RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { remoteBlockFailureInputSchema } from "@planweave-ai/runtime";
import type {
  CanvasExecutionRuntimeLease,
  CanvasExecutionRuntimeLeasePort
} from "./canvas/executionRuntimePort.js";
import type { HostCapacityReservation } from "./hostReservations.js";
import { HostReservationRepository } from "./hostReservations.js";
import { remoteBlockIdentity } from "./remoteBlockIdentity.js";
import type {
  RemoteAcpTranscriptPort,
  RemoteArtifactContentPort,
  RemoteCoordinatorCheckpoint,
  RemoteDispatchPersistencePort,
  RemoteOperationCandidatePort
} from "./remoteBlockCoordinatorPorts.js";
import { RemoteOperationRepository, type RemoteOperation } from "./remoteOperations.js";
import {
  diagnosticFromReenterFailure,
  isMissingActiveOwnership,
  isWritebackDomainFailure
} from "./remoteReenterRecovery.js";

type TerminalStatus = "completed" | "failed" | "cancelled";

export type RemoteBlockWritebackCoordinatorOptions = {
  runtimeLeases: CanvasExecutionRuntimeLeasePort;
  operations: RemoteOperationRepository;
  candidates: RemoteOperationCandidatePort;
  reservations: HostReservationRepository;
  dispatches: RemoteDispatchPersistencePort;
  artifactContent: RemoteArtifactContentPort;
  acpTranscript: RemoteAcpTranscriptPort;
  checkpoint(point: RemoteCoordinatorCheckpoint): Promise<void>;
  authorizeActiveWriteback(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate | undefined,
    reservation: HostCapacityReservation
  ): void;
};

/** Owns terminal package writeback, failure sealing, and attempt lease finalization. */
export class RemoteBlockWritebackCoordinator {
  constructor(private readonly options: RemoteBlockWritebackCoordinatorOptions) {}

  async complete(operationId: string, existingLease?: CanvasExecutionRuntimeLease): Promise<void> {
    if (existingLease) {
      await this.completeWithLease(operationId, existingLease);
      return;
    }
    const operation = this.options.operations.getRequired(operationId);
    const lease = await this.options.runtimeLeases.acquire(operation);
    try {
      await this.completeWithLease(operationId, lease);
    } finally {
      await lease.release();
    }
  }

  async fail(operationId: string, existingLease?: CanvasExecutionRuntimeLease): Promise<void> {
    if (existingLease) {
      await this.failWithLease(operationId, existingLease);
      return;
    }
    const operation = this.options.operations.getRequired(operationId);
    const lease = await this.options.runtimeLeases.acquire(operation);
    try {
      await this.failWithLease(operationId, lease);
    } finally {
      await lease.release();
    }
  }

  async sealOperationLocalFailure(
    operation: RemoteOperation,
    error: unknown,
    existingLease?: CanvasExecutionRuntimeLease
  ): Promise<{ operation: RemoteOperation; status: "terminal" }> {
    const current = this.options.operations.getRequired(operation.id);
    if (isTerminal(current.state)) return { operation: current, status: "terminal" };
    const persisted = this.options.dispatches.inspect(current).dispatch;
    if (
      persisted?.status === "awaiting_writeback" &&
      persisted.terminalAction?.kind === "complete"
    ) {
      if (existingLease) {
        await this.sealRejectedWriteback(current, error, existingLease.runtime);
      } else {
        const runtimeLease = await this.options.runtimeLeases.acquire(current);
        try {
          await this.sealRejectedWriteback(current, error, runtimeLease.runtime);
        } finally {
          await runtimeLease.release();
        }
      }
      return {
        operation: this.options.operations.getRequired(current.id),
        status: "terminal"
      };
    }
    if (persisted?.status === "awaiting_writeback" && persisted.terminalAction?.kind === "fail") {
      try {
        await this.fail(current.id, existingLease);
      } catch (failError) {
        if (!isMissingActiveOwnership(failError) && !isWritebackDomainFailure(failError)) {
          throw failError;
        }
        this.forceFailedTerminal(current);
      }
      return {
        operation: this.options.operations.getRequired(current.id),
        status: "terminal"
      };
    }
    this.forceFailedTerminal(current);
    return {
      operation: this.options.operations.getRequired(current.id),
      status: "terminal"
    };
  }

  finalizeOperationTerminal(operation: RemoteOperation, status: TerminalStatus): void {
    if (!operation.attempt.leaseId) throw new Error("remote_terminal_attempt_not_bound");
    const reservation = this.options.reservations.getRequired(operation.attempt.leaseId);
    if (reservation.status === "active") {
      this.options.reservations.release({
        leaseId: reservation.leaseId,
        fencingToken: reservation.fencingToken,
        expectedVersion: reservation.version,
        reason: status
      });
      return;
    }
    const current = this.options.operations.getRequired(operation.id);
    this.options.reservations.finalizeFencedAttempt({
      operationId: current.id,
      executionAttemptId: current.executionAttemptId,
      leaseId: reservation.leaseId,
      status
    });
  }

  private async completeWithLease(
    operationId: string,
    runtimeLease: CanvasExecutionRuntimeLease
  ): Promise<void> {
    let operation = this.options.operations.getRequired(operationId);
    if (this.reconcileTerminalOperationReplay(operation)) return;
    this.authorizeWritebackIfLeaseActive(operation);
    const terminal = this.options.dispatches.inspect(operation).dispatch;
    if (terminal?.status !== "awaiting_writeback" || terminal.terminalAction?.kind !== "complete") {
      throw new Error("remote_completion_evidence_missing");
    }
    await this.options.checkpoint("after_terminal_event_persistence");
    const reportArtifactRef = terminal.terminalAction.reportArtifactRef;
    const reportBytes = new Uint8Array(
      await this.options.artifactContent.readReport(reportArtifactRef)
    );
    const candidate = this.options.candidates.get(operation.id);
    if (!candidate) throw new Error("remote_operation_candidate_missing");
    const observedTranscript = this.options.acpTranscript.readCompletionTranscript(
      operation.executionAttemptId
    );
    const transcript = observedTranscript
      ? {
          ...observedTranscript,
          executor: candidate.effectiveExecutor,
          agentId: candidate.agentId
        }
      : null;
    await this.options.checkpoint("before_runtime_writeback");
    try {
      await runtimeLease.runtime.complete({
        ...remoteBlockIdentity(operation),
        reportArtifactRef,
        reportBytes,
        ...(transcript ? { transcript } : {})
      });
    } catch (error) {
      if (!isWritebackDomainFailure(error)) throw error;
      await this.sealRejectedWriteback(operation, error, runtimeLease.runtime);
      return;
    }
    await this.options.checkpoint("after_runtime_writeback");
    operation = this.options.operations.getRequired(operation.id);
    this.options.dispatches.finishTerminal({ operation, status: "completed" });
    await this.options.checkpoint("after_dispatch_terminal_persistence");
    this.finalizeOperationTerminal(operation, "completed");
    await this.options.checkpoint("after_terminal_persistence");
  }

  private async failWithLease(
    operationId: string,
    runtimeLease: CanvasExecutionRuntimeLease
  ): Promise<void> {
    let operation = this.options.operations.getRequired(operationId);
    if (this.reconcileTerminalOperationReplay(operation)) return;
    this.authorizeWritebackIfLeaseActive(operation);
    const terminal = this.options.dispatches.inspect(operation).dispatch;
    if (terminal?.status !== "awaiting_writeback" || terminal.terminalAction?.kind !== "fail") {
      const current = this.options.dispatches.inspect(operation).dispatch;
      if (current?.status === "failed" || current?.status === "cancelled") {
        this.finalizeOperationTerminal(operation, current.status);
        return;
      }
      throw new Error("remote_failure_evidence_missing");
    }
    await this.options.checkpoint("after_terminal_event_persistence");
    const failure = terminal.terminalAction.failure;
    await this.options.checkpoint("before_runtime_writeback");
    await runtimeLease.runtime.fail(
      remoteBlockFailureInputSchema.parse({
        ...remoteBlockIdentity(operation),
        failure,
        ...(operation.endpointSelection?.agentId
          ? { agentId: operation.endpointSelection.agentId }
          : {})
      })
    );
    await this.options.checkpoint("after_runtime_writeback");
    operation = this.options.operations.getRequired(operation.id);
    const status = failure.code === "execution_cancelled" ? "cancelled" : "failed";
    this.options.dispatches.finishTerminal({ operation, status });
    await this.options.checkpoint("after_dispatch_terminal_persistence");
    this.finalizeOperationTerminal(operation, status);
    await this.options.checkpoint("after_terminal_persistence");
  }

  private async sealRejectedWriteback(
    operation: RemoteOperation,
    error: unknown,
    runtime: RemoteBlockRuntimePort
  ): Promise<void> {
    const diagnostic = diagnosticFromReenterFailure(error);
    this.options.operations.recordDiagnostic(operation.id, diagnostic.code, diagnostic.message);
    try {
      await runtime.fail(
        remoteBlockFailureInputSchema.parse({
          ...remoteBlockIdentity(operation),
          failure: {
            code: "protocol_error",
            message: diagnostic.message,
            retryable: false
          },
          ...(operation.endpointSelection?.agentId
            ? { agentId: operation.endpointSelection.agentId }
            : {})
        })
      );
    } catch (failError) {
      if (!isMissingActiveOwnership(failError)) throw failError;
    }
    await this.options.checkpoint("after_runtime_writeback");
    const current = this.options.operations.getRequired(operation.id);
    this.options.dispatches.finishTerminal({ operation: current, status: "failed" });
    await this.options.checkpoint("after_dispatch_terminal_persistence");
    this.finalizeOperationTerminal(current, "failed");
    await this.options.checkpoint("after_terminal_persistence");
  }

  private forceFailedTerminal(operation: RemoteOperation): void {
    const current = this.options.operations.getRequired(operation.id);
    if (isTerminal(current.state)) return;
    const persisted = this.options.dispatches.inspect(current).dispatch;
    if (persisted?.status === "awaiting_writeback") {
      this.options.dispatches.finishTerminal({ operation: current, status: "failed" });
    }
    if (current.attempt.leaseId) {
      this.finalizeOperationTerminal(current, "failed");
      return;
    }
    if (
      current.state === "claimed" &&
      current.attempt.status === "prepared" &&
      current.attempt.hostId === undefined &&
      !persisted
    ) {
      this.options.operations.cancelClaimedAfterRuntimeReset({
        operationId: current.id,
        executionAttemptId: current.executionAttemptId
      });
    }
  }

  private reconcileTerminalOperationReplay(operation: RemoteOperation): boolean {
    if (!isTerminal(operation.state)) return false;
    const dispatch = this.options.dispatches.inspect(operation).dispatch;
    if (!dispatch) throw new Error("remote_dispatch_not_found");
    if (dispatch.status === "awaiting_writeback") {
      this.options.dispatches.finishTerminal({ operation, status: operation.state });
    } else if (dispatch.status !== operation.state) {
      throw new Error("remote_terminal_persistence_conflict");
    }
    this.finalizeOperationTerminal(operation, operation.state);
    return true;
  }

  private authorizeWritebackIfLeaseActive(operation: RemoteOperation): void {
    if (!operation.attempt.leaseId) return;
    const reservation = this.options.reservations.getRequired(operation.attempt.leaseId);
    if (reservation.status !== "active") return;
    const candidate = this.options.candidates.get(operation.id);
    if (operation.endpointSelection && !candidate) {
      throw new Error("remote_operation_candidate_missing");
    }
    this.options.authorizeActiveWriteback(operation, candidate, reservation);
  }
}

function isTerminal(state: RemoteOperation["state"]): state is TerminalStatus {
  return state === "completed" || state === "failed" || state === "cancelled";
}
