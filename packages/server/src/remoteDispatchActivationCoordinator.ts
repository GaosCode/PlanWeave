import {
  agentHostProtocolVersion,
  mailboxCommandSchema,
  type ExecutionEnvelope,
  type InterruptionReason
} from "@planweave-ai/agent-host-protocol";
import type { RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { AgentEndpointCatalogError } from "./agentEndpointCatalog.js";
import type { CanvasExecutionRuntimeLease } from "./canvas/executionRuntimePort.js";
import type { HostCapacityReservation } from "./hostReservations.js";
import type { RemoteBlockCoordinatorOptions } from "./remoteBlockCoordinator.js";
import {
  acquireRemoteRuntimeLease,
  type RemoteCoordinatorCheckpoint,
  type RemoteDispatchAdmissionTarget,
  type RemoteDispatchReconciliationState
} from "./remoteBlockCoordinatorPorts.js";
import { remoteBlockIdentity } from "./remoteBlockIdentity.js";
import {
  describeRemoteDispatchAdmissionDenial,
  PersistedRemoteDispatchAdmissionDenial,
  RemoteDispatchAdmissionCompensationError
} from "./remoteDispatchAdmissionDenial.js";
import type { RemoteOperation } from "./remoteOperations.js";
import {
  isRemoteRuntimeRouteUnavailable,
  type RemoteDispatchOutcome
} from "./remoteReenterRecovery.js";
import { withRemoteRuntimeLease } from "./remoteRuntimeLeaseCleanup.js";

type RuntimeBinding = Awaited<ReturnType<RemoteBlockRuntimePort["reconcile"]>>;

export function isUnpublishedRemoteDispatch(
  operation: RemoteOperation,
  persisted: RemoteDispatchReconciliationState
): boolean {
  return (
    persisted.dispatch?.status === "leased" &&
    operation.attempt.status === "reserved" &&
    !persisted.mailbox
  );
}

export class RemoteDispatchActivationCoordinator {
  constructor(
    private readonly options: Pick<
      RemoteBlockCoordinatorOptions,
      "dispatches" | "reservations" | "runtimeLeases" | "operations" | "mailbox"
    >,
    private readonly authorize: (
      operation: RemoteOperation,
      reservation: HostCapacityReservation
    ) => void,
    private readonly checkpoint: (point: RemoteCoordinatorCheckpoint) => Promise<void>
  ) {}

  async recover(
    operation: RemoteOperation,
    reservation: HostCapacityReservation,
    persisted: RemoteDispatchReconciliationState,
    reenter: (
      lease: CanvasExecutionRuntimeLease,
      admissionDenied: boolean
    ) => Promise<RemoteDispatchOutcome>
  ): Promise<RemoteDispatchOutcome> {
    const unpublished = isUnpublishedRemoteDispatch(operation, persisted);
    const target = this.admissionTarget(operation, reservation, true);
    const priorDenial =
      persisted.dispatch?.status === "interrupted" && !persisted.mailbox
        ? this.readAdmissionError(operation)
        : undefined;
    const denial =
      priorDenial ??
      (unpublished ? this.options.dispatches.checkAdmission(target)?.denial.error : undefined);

    let lease: CanvasExecutionRuntimeLease;
    try {
      lease = await acquireRemoteRuntimeLease(
        this.options.runtimeLeases,
        operation,
        reservation.hostId
      );
    } catch (error) {
      if (denial) this.throwCompensationFailure(denial, error);
      this.recheckAfterRouteFailure(target, unpublished, error);
      throw error;
    }
    return withRemoteRuntimeLease(
      this.options.operations,
      operation.id,
      lease,
      async () => {
        let outcome: RemoteDispatchOutcome;
        try {
          outcome = await reenter(lease, denial !== undefined);
        } catch (error) {
          if (denial) this.throwCompensationFailure(denial, error);
          this.recheckAfterRouteFailure(target, unpublished, error);
          throw error;
        }
        if (denial && !priorDenial) throw new PersistedRemoteDispatchAdmissionDenial(denial);
        return outcome;
      },
      denial !== undefined
    );
  }

  async bindAndPublish(input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
    envelope: ExecutionEnvelope;
    envelopeDigest: string;
    lease: CanvasExecutionRuntimeLease;
    binding?: RuntimeBinding;
  }): Promise<RemoteDispatchOutcome> {
    const { operation, reservation, lease, binding } = input;
    const { dispatches, operations, mailbox } = this.options;
    const identity = remoteBlockIdentity(operation);
    const preflight = binding ? undefined : this.admissionTarget(operation, reservation, true);
    if (preflight) {
      const rejected = dispatches.checkAdmission(preflight);
      if (rejected) {
        try {
          const current = await lease.runtime.query({
            ref: identity.ref,
            operationId: identity.operationId
          });
          await this.interruptRuntime(operation, lease.runtime, rejected.interruption, current);
        } catch (error) {
          this.throwCompensationFailure(rejected.denial.error, error);
        }
        throw new PersistedRemoteDispatchAdmissionDenial(rejected.denial.error);
      }
    }
    try {
      const ownership = binding?.ownership;
      if (
        ownership?.phase !== "active" ||
        ownership.operationId !== identity.operationId ||
        ownership.dispatchId !== identity.dispatchId ||
        ownership.executionAttemptId !== identity.executionAttemptId ||
        ownership.sourceRevision !== identity.sourceRevision ||
        ownership.graphFingerprint !== identity.graphFingerprint ||
        ownership.controlPlane !== identity.controlPlane
      ) {
        await lease.runtime.activate(identity);
      }
      await this.checkpoint("after_runtime_binding");
    } catch (error) {
      if (preflight) {
        this.recheckAfterRouteFailure(preflight, true, error);
        operations.recordDiagnostic(
          operation.id,
          "runtime_activation_conflict",
          error instanceof Error ? error.message : "Runtime activation failed."
        );
      }
      throw error;
    }

    const result = dispatches.activate({
      ...this.admissionTarget(operation, reservation),
      command: mailboxCommandSchema.parse({
        type: "execute_block",
        protocolVersion: agentHostProtocolVersion,
        dispatchId: operation.dispatchId,
        leaseId: reservation.leaseId,
        executionAttemptId: operation.executionAttemptId,
        leaseExpiresAt: reservation.leaseExpiresAt,
        envelopeDigest: input.envelopeDigest,
        envelope: input.envelope
      })
    });
    if ("denial" in result) {
      try {
        await this.interruptRuntime(operation, lease.runtime, result.interruption);
      } catch (error) {
        this.throwCompensationFailure(result.denial.error, error);
      }
      throw new PersistedRemoteDispatchAdmissionDenial(result.denial.error);
    }
    await this.checkpoint("after_mailbox_enqueue");
    if (!result.message.publishedAt) {
      mailbox.publish(result.message);
      await this.checkpoint("after_mailbox_publish");
      dispatches.markMailboxPublished(result.message.messageId);
    }
    operations.recordDiagnosticStage(operation.id, "dispatching");
    operations.clearDiagnostic(operation.id);
    return { operation: operations.getRequired(operation.id), status: "activated" };
  }

  async interruptRuntime(
    operation: RemoteOperation,
    runtime: RemoteBlockRuntimePort,
    interruption: { reason: InterruptionReason; resumable: boolean },
    binding?: RuntimeBinding
  ): Promise<void> {
    const identity = remoteBlockIdentity(operation);
    if (binding?.ownership?.phase === "preparing") await runtime.activate(identity);
    await runtime.markInterrupted({
      ...identity,
      interruption,
      ...(operation.endpointSelection?.agentId
        ? { agentId: operation.endpointSelection.agentId }
        : {})
    });
  }

  private admissionTarget(
    operation: RemoteOperation,
    reservation: HostCapacityReservation,
    waitForHost = false
  ): RemoteDispatchAdmissionTarget {
    return {
      operation,
      reservation,
      reservations: this.options.reservations,
      authorize: (current, currentReservation) => {
        try {
          this.authorize(current, currentReservation);
        } catch (error) {
          if (
            waitForHost &&
            error instanceof AgentEndpointCatalogError &&
            error.unavailableReason === "host_offline"
          ) {
            return undefined;
          }
          return describeRemoteDispatchAdmissionDenial(error);
        }
      }
    };
  }

  private recheckAfterRouteFailure(
    target: RemoteDispatchAdmissionTarget,
    unpublished: boolean,
    error: unknown
  ): void {
    if (!unpublished || !isRemoteRuntimeRouteUnavailable(error)) return;
    const { operation, reservation } = target;
    const priorDenial = this.readAdmissionError(operation);
    if (priorDenial) throw new PersistedRemoteDispatchAdmissionDenial(priorDenial);
    const current = this.options.operations.getRequired(operation.id);
    if (
      current.dispatchId !== operation.dispatchId ||
      current.executionAttemptId !== operation.executionAttemptId ||
      current.attempt.leaseId !== reservation.leaseId ||
      !isUnpublishedRemoteDispatch(current, this.options.dispatches.inspect(current))
    ) {
      return;
    }
    const currentReservation = this.options.reservations.getRequired(reservation.leaseId);
    const rejected = this.options.dispatches.checkAdmission({
      ...target,
      operation: current,
      reservation: currentReservation
    });
    if (rejected) throw new PersistedRemoteDispatchAdmissionDenial(rejected.denial.error);
  }

  private readAdmissionError(operation: RemoteOperation): Error | undefined {
    return this.options.dispatches.readAdmissionError({
      operationId: operation.id,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId
    });
  }

  private throwCompensationFailure(denial: Error, error: unknown): never {
    if (isRemoteRuntimeRouteUnavailable(error))
      throw new PersistedRemoteDispatchAdmissionDenial(denial);
    throw new RemoteDispatchAdmissionCompensationError(error);
  }
}
