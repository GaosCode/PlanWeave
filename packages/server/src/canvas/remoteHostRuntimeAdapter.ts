import {
  canvasRuntimeJsonValueSchema,
  canvasRuntimeLogicalScopeSchema,
  canvasRuntimeGraphFingerprintSchema,
  canvasRuntimeSourceRevisionSchema,
  type CanvasRuntimeOperation,
  type CanvasRuntimeResponsePayload
} from "@planweave-ai/agent-host-protocol";
import {
  canvasRuntimeAvailabilitySchema,
  type CanvasRuntimeAvailability
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type { CanvasScopeRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  remoteBlockArtifactReadInputSchema,
  remoteBlockBindingViewSchema,
  remoteBlockClaimInputSchema,
  remoteBlockCompletionInputSchema,
  remoteBlockDispatchCandidateSchema,
  remoteBlockFailureInputSchema,
  remoteBlockInspectInputSchema,
  remoteBlockInterruptionInputSchema,
  remoteBlockMutationResultSchema,
  remoteBlockOperationQuerySchema,
  remoteBlockRefIdentitySchema,
  remoteBlockRetryAttemptInputSchema,
  type RemoteBlockArtifactSource,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import type { z } from "zod";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import type {
  CanvasExecutionRuntimeLease,
  CanvasExecutionRuntimeLeasePort,
  CanvasRuntimeScopeAvailabilityPort,
  RuntimeCanvasScope
} from "./executionRuntimePort.js";
import { CanvasRuntimeUnavailableError } from "./executionRuntimePort.js";
import type { CanvasRuntimeAvailabilityPort } from "./runtimePort.js";
import { CanvasRuntimeHostLocator } from "./runtimeHostLocator.js";
import { CanvasRuntimeRpcBroker, CanvasRuntimeRpcError } from "./runtimeRpcBroker.js";

type RuntimeResponse = CanvasRuntimeResponsePayload["response"];

function responseError(response: RuntimeResponse): CanvasRuntimeRpcError {
  if (response.outcome !== "error") throw new Error("canvas_runtime_response_error_expected");
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

/** Remote Runtime seam. Artifact bytes remain an explicit HTTP data-plane follow-up. */
export class RemoteHostCanvasRuntimeAdapter
  implements
    CanvasRuntimeAvailabilityPort,
    CanvasExecutionRuntimeLeasePort,
    CanvasRuntimeScopeAvailabilityPort
{
  constructor(
    private readonly locator: CanvasRuntimeHostLocator,
    private readonly broker: CanvasRuntimeRpcBroker
  ) {}

  hasRuntimeScope(scope: RuntimeCanvasScope): boolean {
    try {
      return this.locator.locate(scope).kind === "available";
    } catch {
      return false;
    }
  }

  hasRuntimeProject(scope: { workspaceId: string; projectId: string }): boolean {
    return this.locator.hasAvailableProject(scope);
  }

  async readAvailability(
    scopeInput: CanvasScopeRef,
    _capturedAt?: string
  ): Promise<CanvasRuntimeAvailability> {
    const scope = canvasRuntimeLogicalScopeSchema.parse(scopeInput);
    const located = this.locator.locate(scope);
    if (located.kind === "unavailable") {
      return canvasRuntimeAvailabilitySchema.parse({
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: located.reason,
        ...(located.lastSeenAt ? { lastSeenAt: located.lastSeenAt } : {})
      });
    }
    const response = await this.broker.request(located.hostId, scope, {
      operation: "availability"
    });
    if (response.outcome === "error") throw responseError(response);
    if (response.operation !== "availability") {
      throw new Error("canvas_runtime_response_operation_mismatch");
    }
    return canvasRuntimeAvailabilitySchema.parse({
      schemaVersion: "canvas-runtime-availability/v1",
      ...response.result
    });
  }

  async acquire(scopeInput: RuntimeCanvasScope): Promise<CanvasExecutionRuntimeLease> {
    const scope = canvasRuntimeLogicalScopeSchema.parse(scopeInput);
    const located = this.locator.locate(scope);
    if (located.kind === "unavailable") throw new CanvasRuntimeUnavailableError();
    const attachmentVersion = this.broker.attachmentVersion(located.hostId);
    const response = await this.broker.request(
      located.hostId,
      scope,
      { operation: "acquire" },
      attachmentVersion
    );
    if (response.outcome === "error") throw responseError(response);
    if (response.operation !== "acquire") {
      throw new Error("canvas_runtime_response_operation_mismatch");
    }
    const runtimeLeaseId = response.result.runtimeLeaseId;
    const call = (operation: CanvasRuntimeOperation) =>
      this.broker.request(located.hostId, scope, operation, attachmentVersion);
    const runtime = canonicalRemoteRuntimePort(
      this.createRuntimePort(runtimeLeaseId, call),
      scope.workspaceId
    );
    const artifacts: RemoteBlockArtifactSource = {
      async read(rawInput) {
        remoteBlockArtifactReadInputSchema.parse(rawInput);
        throw new CanvasRuntimeRpcError(
          "canvas_runtime_artifact_data_plane_unavailable",
          false,
          false
        );
      }
    };
    const release = once(async () => {
      const released = await call({ operation: "release", runtimeLeaseId });
      if (released.outcome === "error") throw responseError(released);
      if (released.operation !== "release" || released.result.released !== true) {
        throw new Error("canvas_runtime_release_response_invalid");
      }
    });
    return { runtime, artifacts, release };
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
        remoteBlockCompletionInputSchema.parse(rawInput);
        throw new CanvasRuntimeRpcError(
          "canvas_runtime_artifact_data_plane_unavailable",
          false,
          false
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

/** Local bindings have explicit priority; remote resolution is consulted only when local misses. */
export class LocalFirstCanvasRuntimeRouter
  implements
    CanvasRuntimeAvailabilityPort,
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

  readAvailability(scope: CanvasScopeRef, capturedAt?: string) {
    if (this.localScopes.hasRuntimeScope(scope)) {
      return this.localAvailability.readAvailability(scope, capturedAt);
    }
    if (this.remote) return this.remote.readAvailability(scope, capturedAt);
    return Promise.resolve(
      canvasRuntimeAvailabilitySchema.parse({
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "runtime_not_attached"
      })
    );
  }

  acquire(scope: RuntimeCanvasScope): Promise<CanvasExecutionRuntimeLease> {
    if (this.localScopes.hasRuntimeScope(scope))
      return Promise.resolve(this.localLeases.acquire(scope));
    if (this.remote) return this.remote.acquire(scope);
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

export class LocalFirstCanvasExecutionRuntimeRouter implements CanvasExecutionRuntimeLeasePort {
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
