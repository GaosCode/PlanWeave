import {
  canvasRuntimeArtifactMetadataSchema,
  canvasRuntimeArtifactTransferInputSchema,
  canvasRuntimeJsonValueSchema,
  canvasRuntimeLogicalScopeSchema,
  canvasRuntimeGraphFingerprintSchema,
  canvasRuntimeResetInputSchema,
  canvasRuntimeResetResultSchema,
  canvasRuntimeResetStatusResultSchema,
  canvasRuntimeSourceRevisionSchema,
  type CanvasRuntimeOperation,
  type CanvasRuntimeResponsePayload
} from "@planweave-ai/agent-host-protocol";
import { createHash } from "node:crypto";
import {
  canvasRuntimeExecutionAvailabilitySchema,
  type CanvasRuntimeExecutionAvailability
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type { CanvasScopeRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { canvasRuntimeStatusProjectionSchema } from "@planweave-ai/collaboration-protocol/canvas/status";
import {
  remoteBlockArtifactReadInputSchema,
  remoteBlockBindingViewSchema,
  remoteBlockClaimInputSchema,
  remoteBlockCompletionInputSchema,
  remoteBlockCompletionResultSchema,
  remoteBlockDispatchCandidateSchema,
  remoteBlockFailureInputSchema,
  remoteBlockInspectInputSchema,
  remoteBlockInterruptionInputSchema,
  remoteBlockMutationResultSchema,
  remoteBlockOperationQuerySchema,
  remoteBlockRefIdentitySchema,
  remoteBlockRetryAttemptInputSchema,
  RemoteOwnershipConflictError,
  type RemoteBlockArtifactSource,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import type { z } from "zod";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import type {
  CanvasExecutionRuntimeLease,
  CanvasExecutionRuntimeLeasePort,
  CanvasRuntimeScopeAvailabilityPort,
  CanvasExecutionRuntimeRoutePort,
  RuntimeCanvasScope
} from "./executionRuntimePort.js";
import {
  CanvasRuntimeUnavailableError,
  CanvasRuntimeResetConflictError
} from "./executionRuntimePort.js";
import type {
  CanvasRuntimeAuthorityAvailabilityPort,
  CanvasRuntimeAvailabilityPort
} from "./runtimePort.js";
import { CanvasRuntimeHostLocator } from "./runtimeHostLocator.js";
import { CanvasRuntimeRpcBroker, CanvasRuntimeRpcError } from "./runtimeRpcBroker.js";
import type { ArtifactStore } from "../artifacts.js";
import type { RuntimeArtifactGrantRepository } from "./runtimeArtifactGrantRepository.js";
import type { CanvasRuntimeContentTarget } from "@planweave-ai/collaboration-protocol/content/version";
import {
  firstExactRuntimeAuthorityCandidate,
  type RuntimeAuthorityCandidate,
  type RuntimeAuthorityCandidateHandle,
  type RuntimeAuthorityCandidateObservation,
  type RuntimeReadAuthority
} from "./runtimeAuthorityCandidates.js";

type RuntimeResponse = CanvasRuntimeResponsePayload["response"];
type CanvasRuntimeAvailabilityDiagnostic = {
  hostId: string;
  category: "peer_error" | "cancelled";
  code: string;
};

type CanvasRuntimeAvailabilityDiagnosticSink = (
  diagnostic: CanvasRuntimeAvailabilityDiagnostic
) => void;

type CanvasRuntimeAvailabilityOptions = {
  requestTimeoutMs?: number;
  diagnosticSink?: CanvasRuntimeAvailabilityDiagnosticSink;
};

function responseError(response: RuntimeResponse): Error {
  if (response.outcome !== "error") throw new Error("canvas_runtime_response_error_expected");
  switch (response.error.code) {
    case "remote_ownership_requires_executable_block":
    case "remote_ownership_requires_implementation":
    case "remote_ownership_requires_ready_block":
    case "remote_ownership_operation_conflict":
    case "remote_ownership_source_conflict":
    case "remote_ownership_not_preparing":
    case "remote_ownership_activation_conflict":
    case "remote_ownership_not_active":
    case "remote_ownership_terminal_conflict":
    case "remote_ownership_status_conflict":
    case "remote_ownership_source_drift":
      return new RemoteOwnershipConflictError(response.error.code, response.error.message);
  }
  return new CanvasRuntimeRpcError(
    response.error.reconcileRequired ? "canvas_runtime_reconcile_required" : response.error.code,
    response.error.retryable,
    response.error.reconcileRequired === true
  );
}

function parseGenericResult<T>(
  response: RuntimeResponse,
  operation: CanvasRuntimeOperation["operation"],
  schema: z.ZodType<T>
): T {
  if (response.outcome === "error") throw responseError(response);
  if (response.operation !== operation || !("result" in response)) {
    throw new Error("canvas_runtime_response_operation_mismatch");
  }
  return schema.parse(canvasRuntimeJsonValueSchema.parse(response.result));
}

function jsonInput(input: unknown) {
  return canvasRuntimeJsonValueSchema.parse(input);
}

function once<T>(operation: () => T): () => T {
  let called = false;
  let result: T;
  return () => {
    if (!called) {
      called = true;
      result = operation();
    }
    return result;
  };
}

function logicalScope(scopeInput: RuntimeCanvasScope) {
  return canvasRuntimeLogicalScopeSchema.parse({
    workspaceId: scopeInput.workspaceId,
    projectId: scopeInput.projectId,
    canvasId: scopeInput.canvasId
  });
}

function sameRuntimeScope(left: RuntimeCanvasScope, right: RuntimeCanvasScope): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

function unavailableExecution(
  reason: "runtime_not_attached" | "host_offline" | "content_out_of_sync",
  options?: { hostId?: string; lastSeenAt?: string }
): CanvasRuntimeExecutionAvailability {
  return canvasRuntimeExecutionAvailabilitySchema.parse({
    schemaVersion: "canvas-runtime-availability/v1",
    kind: "unavailable",
    reason,
    ...(options?.hostId ? { hostId: options.hostId } : {}),
    ...(options?.lastSeenAt ? { lastSeenAt: options.lastSeenAt } : {})
  });
}

function availabilityCandidateObservation(
  observation: CanvasRuntimeExecutionAvailability
): RuntimeAuthorityCandidateObservation<CanvasRuntimeExecutionAvailability> {
  return observation.kind === "available"
    ? {
        kind: "available",
        evidence: {
          sourceRevision: observation.sourceRevision,
          graphFingerprint: observation.graphFingerprint
        },
        value: observation
      }
    : { kind: "unavailable", reason: observation.reason, value: observation };
}

function matchesAvailabilityScope(
  observation: CanvasRuntimeExecutionAvailability,
  scope: RuntimeCanvasScope
): boolean {
  return (
    observation.kind === "available" &&
    sameRuntimeScope(observation.status.scope, scope) &&
    observation.status.packageFingerprint === observation.graphFingerprint
  );
}

const availabilityDeviceUnavailableCodes = new Set([
  "canvas_runtime_host_offline",
  "canvas_runtime_rpc_deadline_exceeded",
  "canvas_runtime_host_disconnected",
  "canvas_runtime_host_superseded",
  "canvas_runtime_host_revoked"
]);

function isAvailabilityDeviceUnavailableError(error: unknown): error is CanvasRuntimeRpcError {
  return (
    error instanceof CanvasRuntimeRpcError && availabilityDeviceUnavailableCodes.has(error.code)
  );
}

function availabilityDiagnosticCode(error: unknown): string {
  return error instanceof CanvasRuntimeRpcError
    ? error.code
    : "canvas_runtime_availability_peer_unknown";
}

function logCanvasRuntimeAvailabilityDiagnostic(
  diagnostic: CanvasRuntimeAvailabilityDiagnostic
): void {
  console.warn("canvas_runtime_availability_peer_error", diagnostic);
}

/** Remote Runtime seam. Artifact bytes remain an explicit HTTP data-plane follow-up. */
export class RemoteHostCanvasRuntimeAdapter
  implements
    CanvasRuntimeAuthorityAvailabilityPort,
    CanvasExecutionRuntimeRoutePort,
    CanvasRuntimeScopeAvailabilityPort
{
  constructor(
    private readonly locator: CanvasRuntimeHostLocator,
    private readonly broker: CanvasRuntimeRpcBroker,
    private readonly contentTargets: {
      read(scope: RuntimeCanvasScope): CanvasRuntimeContentTarget;
    },
    private readonly artifactDataPlane: {
      grants: RuntimeArtifactGrantRepository;
      artifacts: ArtifactStore;
    },
    private readonly availabilityOptions: CanvasRuntimeAvailabilityOptions = {}
  ) {}

  hasRuntimeScope(scope: RuntimeCanvasScope): boolean {
    return this.locator.locateCandidates(scope).kind === "available";
  }

  hasRuntimeProject(scope: { workspaceId: string; projectId: string }): boolean {
    return this.locator.hasAvailableProject(scope);
  }

  readAvailabilityForAuthority(
    scopeInput: CanvasScopeRef,
    _capturedAt: string | undefined,
    authority: RuntimeReadAuthority
  ): Promise<CanvasRuntimeExecutionAvailability> {
    const scope = canvasRuntimeLogicalScopeSchema.parse(scopeInput);
    return this.aggregateAvailability(scope, {
      target: authority.target,
      sourceRevision: canvasRuntimeSourceRevisionSchema.parse(authority.sourceRevision)
    });
  }

  availabilityCandidates(
    scope: RuntimeCanvasScope,
    authority: RuntimeReadAuthority
  ): RuntimeAuthorityCandidate<CanvasRuntimeExecutionAvailability>[] {
    const located = this.locator.locateCandidates(scope);
    if (located.kind === "unavailable") {
      const unavailable = unavailableExecution(
        located.reason,
        located.lastSeenAt ? { lastSeenAt: located.lastSeenAt } : undefined
      );
      return [
        {
          id: "remote",
          start: () => ({
            response: Promise.resolve({
              kind: "unavailable",
              reason: located.reason,
              value: unavailable
            }),
            cancel: () => false
          })
        }
      ];
    }
    return located.hostIds.map((hostId) => ({
      id: `host:${hostId}`,
      start: () => this.startHostAvailability(hostId, scope, authority.target)
    }));
  }

  private async aggregateAvailability(
    scope: RuntimeCanvasScope,
    authority: RuntimeReadAuthority
  ): Promise<CanvasRuntimeExecutionAvailability> {
    const result = await firstExactRuntimeAuthorityCandidate({
      authority,
      candidates: this.availabilityCandidates(scope, authority),
      matches: (observation) => matchesAvailabilityScope(observation, scope),
      diagnosticCode: availabilityDiagnosticCode,
      diagnose: (diagnostic) =>
        this.reportAvailabilityDiagnostic({
          hostId: diagnostic.candidateId.replace(/^host:/, ""),
          category: diagnostic.category,
          code: diagnostic.code
        })
    });
    if (result.kind === "available") return result.value;
    return result.value ?? unavailableExecution(result.reason);
  }

  reportAvailabilityDiagnostic(diagnostic: CanvasRuntimeAvailabilityDiagnostic): void {
    try {
      (this.availabilityOptions.diagnosticSink ?? logCanvasRuntimeAvailabilityDiagnostic)(
        diagnostic
      );
    } catch {
      // Diagnostics are observational and cannot prevent a peer from settling.
    }
  }

  private startHostAvailability(
    hostId: string,
    scope: RuntimeCanvasScope,
    contentTarget: CanvasRuntimeContentTarget
  ): RuntimeAuthorityCandidateHandle<CanvasRuntimeExecutionAvailability> {
    try {
      const handle = this.broker.requestCancellableRead(
        hostId,
        scope,
        {
          operation: "availability",
          contentTarget
        },
        undefined,
        {
          requestTimeoutMs: this.availabilityOptions.requestTimeoutMs
        }
      );
      return {
        response: this.readHostAvailabilityResponse(handle.response, hostId).then(
          availabilityCandidateObservation
        ),
        cancel: () => {
          return handle.cancel();
        }
      };
    } catch (error) {
      if (isAvailabilityDeviceUnavailableError(error)) {
        return {
          response: Promise.resolve({
            kind: "unavailable",
            reason: "host_offline",
            value: unavailableExecution("host_offline", { hostId })
          }),
          cancel: () => false
        };
      }
      return { response: Promise.reject(error), cancel: () => false };
    }
  }

  private async readHostAvailabilityResponse(
    responsePromise: Promise<RuntimeResponse>,
    hostId: string
  ): Promise<CanvasRuntimeExecutionAvailability> {
    let response: RuntimeResponse;
    try {
      response = await responsePromise;
    } catch (error) {
      if (isAvailabilityDeviceUnavailableError(error)) {
        return unavailableExecution("host_offline", { hostId });
      }
      throw error;
    }
    if (response.outcome === "error") throw responseError(response);
    if (response.operation !== "availability") {
      throw new Error("canvas_runtime_response_operation_mismatch");
    }
    const observation = canvasRuntimeExecutionAvailabilitySchema.parse({
      schemaVersion: "canvas-runtime-availability/v1",
      ...response.result,
      hostId
    });
    return observation;
  }

  acquire(scopeInput: RuntimeCanvasScope): Promise<CanvasExecutionRuntimeLease> {
    return this.acquireLocated(scopeInput, this.locator.locate(logicalScope(scopeInput)));
  }

  acquireForHost(
    scopeInput: RuntimeCanvasScope,
    hostId: string
  ): Promise<CanvasExecutionRuntimeLease> {
    const scope = logicalScope(scopeInput);
    return this.acquireLocated(scope, this.locator.locateAuthorizedHost(scope, hostId));
  }

  private async acquireLocated(
    scopeInput: RuntimeCanvasScope,
    located: ReturnType<CanvasRuntimeHostLocator["locate"]>
  ): Promise<CanvasExecutionRuntimeLease> {
    const scope = logicalScope(scopeInput);
    if (located.kind === "unavailable") {
      throw new CanvasRuntimeUnavailableError(
        located.reason === "host_offline" ? "host_offline" : "runtime_not_attached"
      );
    }
    const attachmentVersion = this.broker.attachmentVersion(located.hostId);
    const response = await this.broker.request(
      located.hostId,
      scope,
      {
        operation: "acquire",
        contentTarget: this.contentTargets.read(scope)
      },
      attachmentVersion
    );
    if (response.outcome === "error") throw responseError(response);
    if (response.operation !== "acquire") {
      throw new Error("canvas_runtime_response_operation_mismatch");
    }
    const runtimeLeaseId = response.result.runtimeLeaseId;
    this.artifactDataPlane.grants.recordLease({
      runtimeLeaseId,
      hostId: located.hostId,
      ...scope,
      attachmentVersion,
      sourceRevision: response.result.sourceRevision,
      graphFingerprint: response.result.graphFingerprint,
      expiresAt: response.result.expiresAt
    });
    const call = (operation: CanvasRuntimeOperation) =>
      this.broker.request(located.hostId, scope, operation, attachmentVersion);
    const runtime = canonicalRemoteRuntimePort(
      this.createRuntimePort(runtimeLeaseId, call),
      scope.workspaceId
    );
    const artifacts: RemoteBlockArtifactSource = {
      read: async (rawInput) => {
        const input = remoteBlockArtifactReadInputSchema.parse(rawInput);
        const sha256 = input.artifactRef.slice("artifact:sha256:".length);
        const operationId = `artifact-read:${createHash("sha256")
          .update(JSON.stringify(input))
          .digest("hex")}`;
        const transfer = this.artifactDataPlane.grants.createUploadGrant({
          runtimeLeaseId,
          operationId,
          artifactRef: input.artifactRef,
          sha256,
          mediaType: input.mediaType,
          maxSizeBytes: this.artifactDataPlane.artifacts.maxArtifactBytes,
          expiresAt: response.result.expiresAt
        });
        if (transfer.direction !== "upload") {
          throw new Error("canvas_runtime_artifact_transfer_direction_invalid");
        }
        const artifactResponse = await call({
          operation: "artifact_read",
          runtimeLeaseId,
          sourceRevision: canvasRuntimeSourceRevisionSchema.parse(input.sourceRevision),
          input: jsonInput(
            canvasRuntimeArtifactTransferInputSchema.parse({ domainInput: input, transfer })
          )
        });
        if (artifactResponse.outcome === "error") throw responseError(artifactResponse);
        if (artifactResponse.operation !== "artifact_read") {
          throw new Error("canvas_runtime_response_operation_mismatch");
        }
        const metadata = canvasRuntimeArtifactMetadataSchema.parse(artifactResponse.result);
        if (
          metadata.artifactRef !== transfer.artifactRef ||
          metadata.sha256 !== transfer.sha256 ||
          metadata.mediaType !== transfer.mediaType ||
          metadata.sizeBytes < 1 ||
          metadata.sizeBytes > transfer.maxSizeBytes
        ) {
          throw new Error("canvas_runtime_artifact_response_mismatch");
        }
        const stored = this.artifactDataPlane.artifacts.getRequired(metadata.artifactRef);
        if (
          stored.ref !== metadata.artifactRef ||
          stored.sha256 !== metadata.sha256 ||
          stored.sizeBytes !== metadata.sizeBytes ||
          stored.mediaType !== metadata.mediaType
        ) {
          throw new Error("canvas_runtime_artifact_response_mismatch");
        }
        const bytes = await this.artifactDataPlane.artifacts.read(metadata.artifactRef);
        return { ...input, bytes: new Uint8Array(bytes) };
      }
    };
    const release = once(async () => {
      this.artifactDataPlane.grants.releaseLease(runtimeLeaseId);
      const released = await call({ operation: "release", runtimeLeaseId });
      if (released.outcome === "error") throw responseError(released);
      if (released.operation !== "release" || released.result.released !== true) {
        throw new Error("canvas_runtime_release_response_invalid");
      }
    });
    const readStatus = async () =>
      parseGenericResult(
        await call({ operation: "status", runtimeLeaseId }),
        "status",
        canvasRuntimeStatusProjectionSchema
      );
    const readInitializationEvidence = async () => {
      const status = await readStatus();
      if (status.packageFingerprint !== response.result.graphFingerprint) {
        throw new CanvasRuntimeResetConflictError("source_drift");
      }
      return {
        sourceRevision: response.result.sourceRevision,
        graphFingerprint: response.result.graphFingerprint,
        status
      };
    };
    const reset = async (command: {
      operationId: string;
      expectedSourceRevision: string;
      expectedGraphFingerprint: string;
      reason?: string;
    }) => {
      const readPrior = async (operationId: string) => {
        const priorResponse = await call({ operation: "reset_status", operationId });
        if (priorResponse.outcome === "error") throw responseError(priorResponse);
        if (priorResponse.operation !== "reset_status") {
          throw new Error("canvas_runtime_response_operation_mismatch");
        }
        return canvasRuntimeResetStatusResultSchema.parse(priorResponse.result);
      };
      const logicalOperationId = command.operationId;
      let hostOperationId = logicalOperationId;
      let prior = await readPrior(hostOperationId);
      if (
        prior.kind === "failed" &&
        !prior.error.reconcileRequired &&
        (prior.error.retryable || prior.error.code === "active_lease")
      ) {
        hostOperationId = `reset-retry:${createHash("sha256")
          .update(`${logicalOperationId}\0${runtimeLeaseId}`)
          .digest("hex")}`;
        prior = await readPrior(hostOperationId);
      }
      if (prior.kind === "succeeded") {
        const result = canvasRuntimeResetResultSchema.parse(prior.result);
        if (result.operationId !== hostOperationId) {
          throw new Error("canvas_runtime_reset_result_identity_mismatch");
        }
        return {
          operationId: logicalOperationId,
          sourceRevision: result.sourceRevision,
          graphFingerprint: result.graphFingerprint,
          status: canvasRuntimeStatusProjectionSchema.parse(result.status)
        };
      }
      if (prior.kind === "pending") {
        throw new CanvasRuntimeRpcError("canvas_runtime_reconcile_required", true, true);
      }
      if (prior.kind === "failed") {
        throw new CanvasRuntimeRpcError(
          prior.error.reconcileRequired ? "canvas_runtime_reconcile_required" : prior.error.code,
          prior.error.retryable,
          prior.error.reconcileRequired === true
        );
      }
      const response = await call({
        operation: "reset",
        runtimeLeaseId,
        evidence: {
          operationId: hostOperationId,
          sourceRevision: canvasRuntimeSourceRevisionSchema.parse(command.expectedSourceRevision),
          graphFingerprint: canvasRuntimeGraphFingerprintSchema.parse(
            command.expectedGraphFingerprint
          )
        },
        input: canvasRuntimeResetInputSchema.parse({
          operationId: hostOperationId,
          sourceRevision: command.expectedSourceRevision,
          graphFingerprint: command.expectedGraphFingerprint,
          ...(command.reason ? { reason: command.reason } : {})
        })
      });
      if (response.outcome === "error") {
        if (response.error.code === "content_out_of_sync") {
          throw new CanvasRuntimeResetConflictError("source_drift");
        }
        if (response.error.code === "active_lease") {
          throw new CanvasRuntimeResetConflictError("active_lease");
        }
        throw responseError(response);
      }
      if (response.operation !== "reset") {
        throw new Error("canvas_runtime_response_operation_mismatch");
      }
      const result = canvasRuntimeResetResultSchema.parse(response.result);
      if (result.operationId !== hostOperationId) {
        throw new Error("canvas_runtime_reset_result_identity_mismatch");
      }
      return {
        operationId: logicalOperationId,
        sourceRevision: result.sourceRevision,
        graphFingerprint: result.graphFingerprint,
        status: canvasRuntimeStatusProjectionSchema.parse(result.status)
      };
    };
    return { runtime, artifacts, readStatus, readInitializationEvidence, reset, release };
  }

  async reconcileReset(
    scopeInput: RuntimeCanvasScope,
    command: {
      operationId: string;
      expectedSourceRevision: string;
      expectedGraphFingerprint: string;
      reason?: string;
    }
  ) {
    const scope = canvasRuntimeLogicalScopeSchema.parse(scopeInput);
    const located = this.locator.locate(scope);
    if (located.kind === "unavailable") {
      throw new CanvasRuntimeUnavailableError(
        located.reason === "host_offline" ? "host_offline" : "runtime_not_attached"
      );
    }
    const response = await this.broker.request(located.hostId, scope, {
      operation: "reset_status",
      operationId: command.operationId
    });
    if (response.outcome === "error") throw responseError(response);
    if (response.operation !== "reset_status") {
      throw new Error("canvas_runtime_response_operation_mismatch");
    }
    const result = canvasRuntimeResetStatusResultSchema.parse(response.result);
    if (result.kind !== "succeeded") return result;
    const reset = canvasRuntimeResetResultSchema.parse(result.result);
    return {
      kind: "succeeded" as const,
      result: {
        operationId: reset.operationId,
        sourceRevision: reset.sourceRevision,
        graphFingerprint: reset.graphFingerprint,
        status: canvasRuntimeStatusProjectionSchema.parse(reset.status)
      }
    };
  }

  private createRuntimePort(
    runtimeLeaseId: Extract<CanvasRuntimeOperation, { operation: "status" }>["runtimeLeaseId"],
    call: (operation: CanvasRuntimeOperation) => Promise<RuntimeResponse>
  ): RemoteBlockRuntimePort {
    return {
      inspect: async (rawInput) => {
        const input = remoteBlockInspectInputSchema.parse(rawInput);
        return parseGenericResult(
          await call({ operation: "inspect", runtimeLeaseId, input: jsonInput(input) }),
          "inspect",
          remoteBlockDispatchCandidateSchema
        );
      },
      claim: async (rawInput) => {
        const input = remoteBlockClaimInputSchema.parse(rawInput);
        return parseGenericResult(
          await call({
            operation: "claim",
            runtimeLeaseId,
            evidence: {
              operationId: input.operationId,
              sourceRevision: canvasRuntimeSourceRevisionSchema.parse(input.sourceRevision),
              graphFingerprint: canvasRuntimeGraphFingerprintSchema.parse(input.graphFingerprint)
            },
            input: jsonInput(input)
          }),
          "claim",
          remoteBlockBindingViewSchema
        );
      },
      activate: async (rawInput) => {
        const input = remoteBlockRefIdentitySchema.parse(rawInput);
        return parseGenericResult(
          await call(mutationOperation("activate", runtimeLeaseId, input)),
          "activate",
          remoteBlockBindingViewSchema
        );
      },
      query: async (rawInput) => {
        const input = remoteBlockOperationQuerySchema.parse(rawInput);
        return parseGenericResult(
          await call({
            operation: "query",
            runtimeLeaseId,
            operationId: input.operationId,
            input: jsonInput(input)
          }),
          "query",
          remoteBlockBindingViewSchema
        );
      },
      reconcile: async (rawInput) => {
        const input = remoteBlockOperationQuerySchema.parse(rawInput);
        return parseGenericResult(
          await call({
            operation: "reconcile",
            runtimeLeaseId,
            operationId: input.operationId,
            input: jsonInput(input)
          }),
          "reconcile",
          remoteBlockBindingViewSchema
        );
      },
      markInterrupted: async (rawInput) => {
        const input = remoteBlockInterruptionInputSchema.parse(rawInput);
        return parseGenericResult(
          await call(mutationOperation("mark_interrupted", runtimeLeaseId, input)),
          "mark_interrupted",
          remoteBlockMutationResultSchema
        );
      },
      resumeAttempt: async (rawInput) => {
        const input = remoteBlockRefIdentitySchema.parse(rawInput);
        return parseGenericResult(
          await call(mutationOperation("resume_attempt", runtimeLeaseId, input)),
          "resume_attempt",
          remoteBlockBindingViewSchema
        );
      },
      retryAttempt: async (rawInput) => {
        const input = remoteBlockRetryAttemptInputSchema.parse(rawInput);
        return parseGenericResult(
          await call(mutationOperation("retry_attempt", runtimeLeaseId, input)),
          "retry_attempt",
          remoteBlockBindingViewSchema
        );
      },
      complete: async (rawInput) => {
        const input = remoteBlockCompletionInputSchema.parse(rawInput);
        const metadata = this.artifactDataPlane.artifacts.getRequired(input.reportArtifactRef);
        const actualDigest = createHash("sha256").update(input.reportBytes).digest("hex");
        if (
          actualDigest !== metadata.sha256 ||
          input.reportBytes.byteLength !== metadata.sizeBytes
        ) {
          throw new Error("canvas_runtime_report_artifact_mismatch");
        }
        const serverLease = this.artifactDataPlane.grants.lease(runtimeLeaseId);
        if (!serverLease) throw new Error("canvas_runtime_lease_not_found");
        const transfer = this.artifactDataPlane.grants.createDownloadGrant({
          runtimeLeaseId,
          operationId: input.operationId,
          artifactRef: metadata.ref,
          sha256: metadata.sha256,
          sizeBytes: metadata.sizeBytes,
          mediaType: metadata.mediaType,
          expiresAt: serverLease.expiresAt
        });
        const { reportBytes: _reportBytes, ...domainInput } = input;
        return parseGenericResult(
          await call({
            operation: "complete",
            runtimeLeaseId,
            evidence: {
              operationId: input.operationId,
              sourceRevision: canvasRuntimeSourceRevisionSchema.parse(input.sourceRevision),
              graphFingerprint: canvasRuntimeGraphFingerprintSchema.parse(input.graphFingerprint)
            },
            input: jsonInput(
              canvasRuntimeArtifactTransferInputSchema.parse({ domainInput, transfer })
            )
          }),
          "complete",
          remoteBlockCompletionResultSchema
        );
      },
      fail: async (rawInput) => {
        const input = remoteBlockFailureInputSchema.parse(rawInput);
        return parseGenericResult(
          await call(mutationOperation("fail", runtimeLeaseId, input)),
          "fail",
          remoteBlockMutationResultSchema
        );
      }
    };
  }
}

/** Selects read evidence by Server authority while preserving local-first mutation routing. */
export class AuthoritySelectingCanvasRuntimeRouter
  implements
    CanvasRuntimeAuthorityAvailabilityPort,
    CanvasExecutionRuntimeLeasePort,
    CanvasRuntimeScopeAvailabilityPort
{
  private remote: RemoteHostCanvasRuntimeAdapter | undefined;

  constructor(
    private readonly localAvailability: CanvasRuntimeAvailabilityPort,
    private readonly localLeases: CanvasExecutionRuntimeLeasePort,
    private readonly localScopes: CanvasRuntimeScopeAvailabilityPort
  ) {}

  attachRemote(remote: RemoteHostCanvasRuntimeAdapter): void {
    if (this.remote) throw new Error("remote_canvas_runtime_already_attached");
    this.remote = remote;
  }

  async readAvailabilityForAuthority(
    scope: CanvasScopeRef,
    capturedAt: string | undefined,
    authority: RuntimeReadAuthority
  ) {
    const logical = canvasRuntimeLogicalScopeSchema.parse(scope);
    const candidates: RuntimeAuthorityCandidate<CanvasRuntimeExecutionAvailability>[] = [];
    if (this.localScopes.hasRuntimeScope(logical)) {
      candidates.push({
        id: "local",
        start: () => ({
          response: this.localAvailability
            .readAvailability(scope, capturedAt)
            .then(availabilityCandidateObservation),
          cancel: () => false
        })
      });
    }
    if (this.remote) candidates.push(...this.remote.availabilityCandidates(logical, authority));
    const result = await firstExactRuntimeAuthorityCandidate({
      authority,
      candidates,
      matches: (observation) => matchesAvailabilityScope(observation, logical),
      diagnosticCode: availabilityDiagnosticCode,
      diagnose: (diagnostic) =>
        this.remote?.reportAvailabilityDiagnostic({
          hostId: diagnostic.candidateId.replace(/^host:/, ""),
          category: diagnostic.category,
          code: diagnostic.code
        })
    });
    if (result.kind === "available") return result.value;
    return result.value ?? unavailableExecution(result.reason);
  }

  acquire(scope: RuntimeCanvasScope): Promise<CanvasExecutionRuntimeLease> {
    if (this.localScopes.hasRuntimeScope(scope))
      return Promise.resolve(this.localLeases.acquire(scope));
    if (this.remote) return this.remote.acquire(scope);
    return Promise.reject(new CanvasRuntimeUnavailableError());
  }

  acquireForHost(scope: RuntimeCanvasScope, hostId: string): Promise<CanvasExecutionRuntimeLease> {
    if (this.localScopes.hasRuntimeScope(scope)) {
      return Promise.resolve(this.localLeases.acquire(scope));
    }
    if (!this.remote) return Promise.reject(new CanvasRuntimeUnavailableError());
    return this.remote.acquireForHost(scope, hostId);
  }

  reconcileReset(
    scope: RuntimeCanvasScope,
    command: Parameters<NonNullable<CanvasExecutionRuntimeLeasePort["reconcileReset"]>>[1]
  ) {
    if (this.localScopes.hasRuntimeScope(scope)) {
      const reconcile = this.localLeases.reconcileReset;
      if (!reconcile) return Promise.resolve({ kind: "not_found" as const });
      return reconcile.call(this.localLeases, scope, command);
    }
    if (this.remote) return this.remote.reconcileReset(scope, command);
    return Promise.reject(new CanvasRuntimeUnavailableError());
  }

  hasRuntimeScope(scope: RuntimeCanvasScope): boolean {
    return this.localScopes.hasRuntimeScope(scope) || this.remote?.hasRuntimeScope(scope) === true;
  }

  hasRuntimeProject(scope: { workspaceId: string; projectId: string }): boolean {
    return (
      this.localScopes.hasRuntimeProject(scope) || this.remote?.hasRuntimeProject(scope) === true
    );
  }
}

export class LocalFirstCanvasExecutionRuntimeRouter implements CanvasExecutionRuntimeRoutePort {
  private remote: RemoteHostCanvasRuntimeAdapter | undefined;

  constructor(
    private readonly localLeases: CanvasExecutionRuntimeLeasePort,
    private readonly localScopes: CanvasRuntimeScopeAvailabilityPort
  ) {}

  attachRemote(remote: RemoteHostCanvasRuntimeAdapter): void {
    if (this.remote) throw new Error("remote_execution_canvas_runtime_already_attached");
    this.remote = remote;
  }

  acquire(scope: RuntimeCanvasScope): Promise<CanvasExecutionRuntimeLease> {
    if (this.localScopes.hasRuntimeScope(scope)) {
      return Promise.resolve(this.localLeases.acquire(scope));
    }
    if (this.remote) return this.remote.acquire(scope);
    return Promise.reject(new CanvasRuntimeUnavailableError());
  }

  acquireForHost(scope: RuntimeCanvasScope, hostId: string): Promise<CanvasExecutionRuntimeLease> {
    if (this.localScopes.hasRuntimeScope(scope)) {
      return Promise.resolve(this.localLeases.acquire(scope));
    }
    if (!this.remote) return Promise.reject(new CanvasRuntimeUnavailableError());
    return this.remote.acquireForHost(scope, hostId);
  }

  reconcileReset(
    scope: RuntimeCanvasScope,
    command: Parameters<NonNullable<CanvasExecutionRuntimeLeasePort["reconcileReset"]>>[1]
  ) {
    if (this.localScopes.hasRuntimeScope(scope)) {
      const reconcile = this.localLeases.reconcileReset;
      if (!reconcile) return Promise.resolve({ kind: "not_found" as const });
      return reconcile.call(this.localLeases, scope, command);
    }
    if (this.remote) return this.remote.reconcileReset(scope, command);
    return Promise.reject(new CanvasRuntimeUnavailableError());
  }
}

function mutationOperation(
  operation: "activate" | "mark_interrupted" | "resume_attempt" | "retry_attempt" | "fail",
  runtimeLeaseId: Extract<CanvasRuntimeOperation, { operation: "status" }>["runtimeLeaseId"],
  input: {
    operationId: string;
    sourceRevision: string;
    graphFingerprint: string;
  }
): CanvasRuntimeOperation {
  return {
    operation,
    runtimeLeaseId,
    evidence: {
      operationId: input.operationId,
      sourceRevision: canvasRuntimeSourceRevisionSchema.parse(input.sourceRevision),
      graphFingerprint: canvasRuntimeGraphFingerprintSchema.parse(input.graphFingerprint)
    },
    input: jsonInput(input)
  };
}
