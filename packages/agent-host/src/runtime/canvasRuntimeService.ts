import { createHash, randomUUID } from "node:crypto";
import {
  CANVAS_RUNTIME_CAPABILITY,
  canvasRuntimeArtifactTransferInputSchema,
  canvasRuntimeResponsePayloadSchema,
  type CanvasRuntimeCancelCommand,
  type CanvasRuntimeRequestCommand,
  type CanvasRuntimeResponsePayload
} from "@planweave-ai/agent-host-protocol";
import {
  capturePackageSnapshot,
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  readAuthorizedCanvasRuntimeStatus,
  remoteBlockClaimInputSchema,
  remoteBlockCompletionInputSchema,
  remoteBlockFailureInputSchema,
  remoteBlockInspectInputSchema,
  remoteBlockInterruptionInputSchema,
  remoteBlockOperationQuerySchema,
  remoteBlockRefIdentitySchema,
  remoteBlockRetryAttemptInputSchema,
  remoteBlockArtifactReadInputSchema,
  RemoteBlockRuntimeError
} from "@planweave-ai/runtime";
import { ZodError } from "zod";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type {
  CanvasRuntimeLeaseRecord,
  CanvasRuntimeRpcRepository
} from "../state/canvasRuntimeRpcRepository.js";
import {
  CanvasRuntimeResolutionError,
  type CanvasRuntimeResolverPort,
  type ResolvedCanvasRuntime
} from "./canvasRuntimeResolver.js";
import type { CanvasRuntimeArtifactTransferPort } from "../artifacts/canvasRuntimeArtifactTransfer.js";

type CanvasRuntimeCommand = CanvasRuntimeRequestCommand | CanvasRuntimeCancelCommand;
type ResponseOperation = CanvasRuntimeResponsePayload["response"]["operation"];

type ActiveRequest = { controller: AbortController; committed: boolean };

class CanvasRuntimeServiceError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly reconcileRequired = false
  ) {
    super(code);
    this.name = "CanvasRuntimeServiceError";
  }
}

function responseOperation(command: CanvasRuntimeCommand): ResponseOperation {
  return command.type === "canvas_runtime.cancel" ? "cancel" : command.operation.operation;
}

function scopeMatches(command: CanvasRuntimeCommand, lease: CanvasRuntimeLeaseRecord): boolean {
  return (
    command.scope.workspaceId === lease.workspaceId &&
    command.scope.projectId === lease.projectId &&
    command.scope.canvasId === lease.canvasId
  );
}

function errorCode(error: unknown): CanvasRuntimeServiceError {
  if (error instanceof CanvasRuntimeServiceError) return error;
  if (error instanceof CanvasRuntimeResolutionError) {
    return new CanvasRuntimeServiceError(error.code);
  }
  if (error instanceof RemoteBlockRuntimeError) {
    return new CanvasRuntimeServiceError(error.code);
  }
  if (error instanceof ZodError) return new CanvasRuntimeServiceError("invalid_operation_input");
  if (error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message)) {
    return new CanvasRuntimeServiceError(error.message);
  }
  return new CanvasRuntimeServiceError("canvas_runtime_operation_failed");
}

export type CanvasRuntimeServiceOptions = {
  resolver: CanvasRuntimeResolverPort;
  receipts: CanvasRuntimeRpcRepository;
  capabilities: readonly string[];
  artifactTransfer: CanvasRuntimeArtifactTransferPort;
  now?: () => Date;
  leaseDurationMs?: number;
};

export class CanvasRuntimeService {
  private readonly active = new Map<string, ActiveRequest>();
  private readonly localNow: () => Date;
  private readonly leaseDurationMs: number;
  private serverClockOffsetMs = 0;

  constructor(private readonly options: CanvasRuntimeServiceOptions) {
    this.localNow = options.now ?? (() => new Date());
    this.leaseDurationMs = options.leaseDurationMs ?? 5 * 60_000;
  }

  enabled(): boolean {
    return this.options.capabilities.includes(CANVAS_RUNTIME_CAPABILITY);
  }

  updateCredentialToken(token: string): void {
    this.options.artifactTransfer.updateCredentialToken(token);
  }

  synchronizeServerTime(serverTime: string, localNow = this.localNow()): void {
    const serverTimeMs = Date.parse(serverTime);
    if (!Number.isFinite(serverTimeMs)) throw new Error("server_time_invalid");
    this.serverClockOffsetMs = serverTimeMs - localNow.getTime();
    this.options.artifactTransfer.synchronizeServerTime(serverTime, localNow);
  }

  private now(): Date {
    return new Date(this.localNow().getTime() + this.serverClockOffsetMs);
  }

  recover(): void {
    for (const receipt of this.options.receipts.incomplete()) {
      if (receipt.status === "pending") {
        void this.handle(receipt.command);
      } else {
        this.finishError(
          receipt.command,
          new CanvasRuntimeServiceError("reconcile_required", true, true),
          "reconcile_required"
        );
      }
    }
  }

  disconnect(): void {
    for (const request of this.active.values()) request.controller.abort("host_disconnected");
  }

  async handle(command: CanvasRuntimeCommand): Promise<void> {
    if (!this.options.receipts.begin(command.requestId)) return;
    const active: ActiveRequest = { controller: new AbortController(), committed: false };
    this.active.set(command.requestId, active);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = () => {
      const remaining = Date.parse(command.deadline) - this.now().getTime();
      if (remaining <= 0) {
        active.controller.abort("deadline_exceeded");
        return;
      }
      timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
    };
    armDeadline();
    try {
      if (!this.enabled()) throw new CanvasRuntimeServiceError("capability_not_negotiated");
      this.assertOpen(command, active);
      const result =
        command.type === "canvas_runtime.cancel"
          ? await this.cancel(command)
          : await this.execute(command, active);
      this.assertOpen(command, active);
      this.options.receipts.complete(
        command.requestId,
        canvasRuntimeResponsePayloadSchema.parse({
          type: "canvas_runtime.response",
          protocolVersion: 1,
          requestId: command.requestId,
          response: { outcome: "success", operation: responseOperation(command), result }
        })
      );
    } catch (caught) {
      const error =
        active.controller.signal.aborted && active.committed
          ? new CanvasRuntimeServiceError("reconcile_required", true, true)
          : active.controller.signal.aborted
            ? new CanvasRuntimeServiceError(
                active.controller.signal.reason === "deadline_exceeded"
                  ? "deadline_exceeded"
                  : "request_cancelled"
              )
            : errorCode(caught);
      this.finishError(command, error, error.reconcileRequired ? "reconcile_required" : "terminal");
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(command.requestId);
    }
  }

  private finishError(
    command: CanvasRuntimeCommand,
    error: CanvasRuntimeServiceError,
    status: "terminal" | "reconcile_required"
  ): void {
    this.options.receipts.complete(
      command.requestId,
      canvasRuntimeResponsePayloadSchema.parse({
        type: "canvas_runtime.response",
        protocolVersion: 1,
        requestId: command.requestId,
        response: {
          outcome: "error",
          operation: responseOperation(command),
          error: {
            code: error.code,
            message: "The Canvas Runtime request could not be completed.",
            retryable: error.retryable,
            ...(error.reconcileRequired ? { reconcileRequired: true } : {})
          }
        }
      }),
      status
    );
  }

  private assertOpen(command: CanvasRuntimeCommand, active: ActiveRequest): void {
    if (Date.parse(command.deadline) <= this.now().getTime()) {
      active.controller.abort("deadline_exceeded");
    }
    if (active.controller.signal.aborted) throw new CanvasRuntimeServiceError("request_cancelled");
  }

  private async cancel(command: CanvasRuntimeCancelCommand) {
    await this.options.resolver.resolve(command.scope);
    const target = this.active.get(command.targetRequestId);
    target?.controller.abort("request_cancelled");
    return { targetRequestId: command.targetRequestId, cancelled: Boolean(target) };
  }

  private async execute(command: CanvasRuntimeRequestCommand, active: ActiveRequest) {
    const resolved = await this.options.resolver.resolve(command.scope);
    this.assertOpen(command, active);
    switch (command.operation.operation) {
      case "availability":
        return this.availability(resolved);
      case "acquire":
        return this.acquire(command, resolved);
      case "release": {
        this.requireLease(command, command.operation.runtimeLeaseId, true);
        return { released: this.options.receipts.releaseLease(command.operation.runtimeLeaseId) };
      }
      default:
        return this.executeLeased(command, resolved, active);
    }
  }

  private async availability(resolved: ResolvedCanvasRuntime) {
    const [{ snapshot }, status] = await Promise.all([
      capturePackageSnapshot({ projectRoot: resolved.canvas }),
      readAuthorizedCanvasRuntimeStatus({
        projectRoot: resolved.project.rootPath,
        canvasId: resolved.scope.canvasId,
        expectedPackageDir: resolved.canvas.packageDir,
        scope: canvasScopeRefSchema.parse(resolved.scope)
      })
    ]);
    return {
      kind: "available" as const,
      status,
      sourceRevision: snapshot.sourceRevision,
      graphFingerprint: status.packageFingerprint
    };
  }

  private async acquire(command: CanvasRuntimeRequestCommand, resolved: ResolvedCanvasRuntime) {
    if (command.operation.operation !== "acquire") throw new Error("invalid_operation_input");
    const available = await this.availability(resolved);
    const expected = command.operation.expectedEvidence;
    if (
      expected &&
      (expected.sourceRevision !== available.sourceRevision ||
        expected.graphFingerprint !== available.graphFingerprint)
    ) {
      throw new CanvasRuntimeServiceError("content_out_of_sync");
    }
    const acquiredAt = this.now().toISOString();
    const expiresAt = new Date(
      Math.min(Date.parse(command.deadline), this.now().getTime() + this.leaseDurationMs)
    ).toISOString();
    if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) {
      throw new CanvasRuntimeServiceError("deadline_exceeded");
    }
    const runtimeLeaseId = randomUUID();
    this.options.receipts.createLease({
      runtimeLeaseId,
      ...command.scope,
      sourceRevision: available.sourceRevision,
      graphFingerprint: available.graphFingerprint,
      status: "active",
      acquiredAt,
      expiresAt
    });
    return {
      runtimeLeaseId,
      sourceRevision: available.sourceRevision,
      graphFingerprint: available.graphFingerprint,
      acquiredAt,
      expiresAt
    };
  }

  private requireLease(
    command: CanvasRuntimeRequestCommand,
    runtimeLeaseId: string,
    allowInactive = false
  ) {
    const lease = this.options.receipts.lease(runtimeLeaseId);
    if (!lease || !scopeMatches(command, lease)) {
      throw new CanvasRuntimeServiceError("runtime_lease_not_found");
    }
    if (
      !allowInactive &&
      (lease.status !== "active" || Date.parse(lease.expiresAt) <= this.now().getTime())
    ) {
      throw new CanvasRuntimeServiceError("runtime_lease_expired");
    }
    return lease;
  }

  private async executeLeased(
    command: CanvasRuntimeRequestCommand,
    resolved: ResolvedCanvasRuntime,
    active: ActiveRequest
  ) {
    if (!("runtimeLeaseId" in command.operation)) throw new Error("runtime_lease_required");
    const lease = this.requireLease(command, command.operation.runtimeLeaseId);
    const runtime = createRemoteBlockRuntimePort({ projectRoot: resolved.canvas });
    const operation = command.operation;
    switch (operation.operation) {
      case "status":
        return (await this.availability(resolved)).status;
      case "inspect":
        return runtime.inspect(remoteBlockInspectInputSchema.parse(operation.input));
      case "claim": {
        const input = remoteBlockClaimInputSchema.parse(operation.input);
        active.committed = true;
        return runtime.claim(input);
      }
      case "activate": {
        const input = remoteBlockRefIdentitySchema.parse(operation.input);
        active.committed = true;
        return runtime.activate(input);
      }
      case "query":
        return runtime.query(remoteBlockOperationQuerySchema.parse(operation.input));
      case "reconcile":
        return runtime.reconcile(remoteBlockOperationQuerySchema.parse(operation.input));
      case "mark_interrupted": {
        const input = remoteBlockInterruptionInputSchema.parse(operation.input);
        active.committed = true;
        return runtime.markInterrupted(input);
      }
      case "resume_attempt": {
        const input = remoteBlockRefIdentitySchema.parse(operation.input);
        active.committed = true;
        return runtime.resumeAttempt(input);
      }
      case "retry_attempt": {
        const input = remoteBlockRetryAttemptInputSchema.parse(operation.input);
        active.committed = true;
        return runtime.retryAttempt(input);
      }
      case "complete": {
        const transferInput = canvasRuntimeArtifactTransferInputSchema.parse(operation.input);
        if (
          transferInput.transfer.direction !== "download" ||
          transferInput.transfer.runtimeLeaseId !== lease.runtimeLeaseId
        ) {
          throw new CanvasRuntimeServiceError("invalid_operation_input");
        }
        const reportBytes = await this.options.artifactTransfer.download(
          transferInput.transfer,
          active.controller.signal
        );
        const domainInput = remoteBlockCompletionInputSchema
          .omit({ reportBytes: true })
          .parse(transferInput.domainInput);
        const input = remoteBlockCompletionInputSchema.parse({
          ...domainInput,
          reportBytes
        });
        active.committed = true;
        return runtime.complete(input);
      }
      case "fail": {
        const input = remoteBlockFailureInputSchema.parse(operation.input);
        active.committed = true;
        return runtime.fail(input);
      }
      case "artifact_read": {
        const transferInput = canvasRuntimeArtifactTransferInputSchema.parse(operation.input);
        if (
          transferInput.transfer.direction !== "upload" ||
          transferInput.transfer.runtimeLeaseId !== lease.runtimeLeaseId
        ) {
          throw new CanvasRuntimeServiceError("invalid_operation_input");
        }
        const input = remoteBlockArtifactReadInputSchema.parse(transferInput.domainInput);
        const artifact = await createRemoteBlockArtifactSource({
          projectRoot: resolved.canvas
        }).read(input);
        const sha256 = createHash("sha256").update(artifact.bytes).digest("hex");
        if (
          artifact.artifactRef !== transferInput.transfer.artifactRef ||
          artifact.mediaType !== transferInput.transfer.mediaType ||
          sha256 !== transferInput.transfer.sha256
        ) {
          throw new CanvasRuntimeServiceError("runtime_artifact_evidence_mismatch");
        }
        await this.options.artifactTransfer.upload(
          transferInput.transfer,
          artifact.bytes,
          artifact.mediaType,
          active.controller.signal
        );
        return {
          artifactRef: artifact.artifactRef,
          sha256,
          sizeBytes: artifact.bytes.byteLength,
          mediaType: artifact.mediaType
        };
      }
      default:
        throw new CanvasRuntimeServiceError("unsupported_canvas_runtime_operation");
    }
  }
}
