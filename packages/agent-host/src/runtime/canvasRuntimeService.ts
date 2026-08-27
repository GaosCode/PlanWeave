import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CANVAS_RUNTIME_CAPABILITY,
  canvasRuntimeArtifactTransferInputSchema,
  canvasRuntimeResetInputSchema,
  canvasRuntimeResetResultSchema,
  canvasRuntimeResponsePayloadSchema,
  type CanvasRuntimeCancelCommand,
  type CanvasRuntimeLogicalScope,
  type CanvasRuntimeRequestCommand,
  type CanvasRuntimeResponsePayload
} from "@planweave-ai/agent-host-protocol";
import {
  capturePackageSnapshot,
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  readAuthorizedCanvasRuntimeStatus,
  readRuntimeResetReceipt,
  remoteBlockClaimInputSchema,
  remoteBlockCompletionInputSchema,
  remoteBlockFailureInputSchema,
  remoteBlockInspectInputSchema,
  remoteBlockInterruptionInputSchema,
  remoteBlockOperationQuerySchema,
  remoteBlockRefIdentitySchema,
  remoteBlockRetryAttemptInputSchema,
  remoteBlockArtifactReadInputSchema,
  RemoteBlockRuntimeError,
  materializeAuthoritativeCanvasWorkspace,
  recoverPendingAuthoritativeCanvasMaterialization,
  withAuthoritativeCanvasWorkspaceLock,
  resetRuntimeState
} from "@planweave-ai/runtime";
import { ZodError } from "zod";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  canvasRuntimeContentTargetSchema,
  type CanvasRuntimeContentTarget
} from "@planweave-ai/collaboration-protocol/content/version";
import type {
  CanvasRuntimeLeaseRecord,
  CanvasRuntimeResetResolution,
  CanvasRuntimeRpcRepository
} from "../state/canvasRuntimeRpcRepository.js";
import {
  CanvasRuntimeResolutionError,
  type CanvasRuntimeResolverPort,
  type ResolvedCanvasRuntime
} from "./canvasRuntimeResolver.js";
import type { CanvasRuntimeArtifactTransferPort } from "../artifacts/canvasRuntimeArtifactTransfer.js";
import { resolveCanvasRuntimeWorkItems } from "./canvasRuntimeWorkItemFacts.js";
import type { CanvasRuntimeContentTransferPort } from "./canvasRuntimeContentTransfer.js";

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

function contentTargetMatches(
  left: CanvasRuntimeContentTarget | undefined,
  right: CanvasRuntimeContentTarget
): boolean {
  return (
    left?.revision === right.revision &&
    left.content.versionId === right.content.versionId &&
    left.content.canonicalDigest === right.content.canonicalDigest &&
    left.graphFingerprint === right.graphFingerprint
  );
}

export class CanvasRuntimeMaterializationEvidenceError extends Error {
  constructor(options?: ErrorOptions) {
    super("runtime_materialization_evidence_mismatch", options);
    this.name = "CanvasRuntimeMaterializationEvidenceError";
  }
}

type ExpectedCanvasRuntimeMaterializationEvidence = {
  sourceRevision?: string;
  graphFingerprint: string;
  contentTarget?: CanvasRuntimeContentTarget;
};

async function readCanvasRuntimeAvailability(resolved: ResolvedCanvasRuntime) {
  const [{ snapshot }, status] = await Promise.all([
    capturePackageSnapshot({ projectRoot: resolved.canvas }),
    readAuthorizedCanvasRuntimeStatus({
      projectRoot: resolved.canvas,
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

async function requireCanvasRuntimeMaterializationEvidence(
  resolved: ResolvedCanvasRuntime,
  expected: ExpectedCanvasRuntimeMaterializationEvidence
) {
  try {
    const receipt = canvasRuntimeContentTargetSchema.parse(
      JSON.parse(
        await readFile(join(resolved.canvas.workspaceRoot, "authority-content-target.json"), "utf8")
      )
    );
    const available = await readCanvasRuntimeAvailability(resolved);
    if (
      receipt.graphFingerprint !== available.graphFingerprint ||
      receipt.graphFingerprint !== expected.graphFingerprint ||
      available.graphFingerprint !== expected.graphFingerprint ||
      (expected.sourceRevision !== undefined &&
        available.sourceRevision !== expected.sourceRevision) ||
      (expected.contentTarget !== undefined &&
        !contentTargetMatches(receipt, expected.contentTarget))
    ) {
      throw new CanvasRuntimeMaterializationEvidenceError();
    }
    return available;
  } catch (error) {
    if (error instanceof CanvasRuntimeMaterializationEvidenceError) throw error;
    throw new CanvasRuntimeMaterializationEvidenceError({ cause: error });
  }
}

export async function readCanvasRuntimeMaterializationEvidence(
  resolved: ResolvedCanvasRuntime,
  expected: { sourceRevision: string; graphFingerprint: string }
) {
  return withAuthoritativeCanvasWorkspaceLock(resolved.canvas, async () => {
    await recoverPendingAuthoritativeCanvasMaterialization(resolved.canvas);
    return requireCanvasRuntimeMaterializationEvidence(resolved, expected);
  });
}

function errorCode(error: unknown): CanvasRuntimeServiceError {
  if (error instanceof CanvasRuntimeServiceError) return error;
  if (error instanceof CanvasRuntimeMaterializationEvidenceError) {
    return new CanvasRuntimeServiceError("content_out_of_sync");
  }
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
  contentTransfer: CanvasRuntimeContentTransferPort;
  now?: () => Date;
  leaseDurationMs?: number;
};

export class CanvasRuntimeService {
  private readonly active = new Map<string, ActiveRequest>();
  private readonly materializationLocks = new Map<string, Promise<void>>();
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
    this.options.contentTransfer.updateCredentialToken(token);
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
      } else if (
        receipt.command.type === "canvas_runtime.request" &&
        receipt.command.operation.operation === "reset"
      ) {
        void this.recoverInterruptedReset(receipt.command);
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
    if (command.operation.operation === "reset_status") {
      const stored = this.options.receipts.resetStatus(
        command.scope,
        command.operation.operationId
      );
      if (
        stored.kind === "not_found" ||
        stored.kind === "succeeded" ||
        (stored.kind === "failed" && !stored.error.reconcileRequired)
      ) {
        return stored;
      }
      const resolved = await this.options.resolver.resolve(command.scope);
      return this.resetStatus(command, resolved, stored);
    }
    const resolved = await this.options.resolver.resolve(command.scope);
    this.assertOpen(command, active);
    const operation = command.operation;
    if (operation.operation === "availability") {
      const target = canvasRuntimeContentTargetSchema.parse(operation.contentTarget);
      return this.withMaterializationLock(command.scope, resolved, async () => {
        await this.ensureMaterialized(command, resolved, target, active);
        return this.availability(resolved);
      });
    }
    if (operation.operation === "resolve_work_items") {
      const target = canvasRuntimeContentTargetSchema.parse(operation.contentTarget);
      return this.withMaterializationLock(command.scope, resolved, async () => {
        await this.ensureMaterialized(command, resolved, target, active);
        return resolveCanvasRuntimeWorkItems(resolved, operation.input);
      });
    }
    if (operation.operation === "acquire") {
      const target = canvasRuntimeContentTargetSchema.parse(operation.contentTarget);
      return this.withMaterializationLock(command.scope, resolved, async () => {
        await this.ensureMaterialized(command, resolved, target, active);
        return this.acquire(command, resolved);
      });
    }
    switch (operation.operation) {
      case "release": {
        const { runtimeLeaseId } = operation;
        return this.withScopeLane(command.scope, async () => {
          this.requireLease(command, runtimeLeaseId, true);
          return {
            released: this.options.receipts.releaseLease(runtimeLeaseId)
          };
        });
      }
      default:
        return this.withScopeLane(command.scope, () =>
          this.executeLeased(command, resolved, active)
        );
    }
  }

  private async ensureMaterialized(
    command: CanvasRuntimeRequestCommand,
    resolved: ResolvedCanvasRuntime,
    target: CanvasRuntimeContentTarget,
    active: ActiveRequest
  ): Promise<void> {
    await recoverPendingAuthoritativeCanvasMaterialization(resolved.canvas);
    const receiptFile = join(resolved.canvas.workspaceRoot, "authority-content-target.json");
    const materializedTarget = await this.readMaterializedContentTarget(receiptFile);
    let currentFingerprint: string | undefined;
    let manifestExists = true;
    try {
      await access(resolved.canvas.manifestFile);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      manifestExists = false;
    }
    if (manifestExists) {
      currentFingerprint = (await this.availability(resolved)).graphFingerprint;
    }
    if (
      !contentTargetMatches(materializedTarget, target) ||
      currentFingerprint !== target.graphFingerprint
    ) {
      const hasLiveLease = this.options.receipts
        .activeLeases(command.scope)
        .some((lease) => Date.parse(lease.expiresAt) > this.now().getTime());
      if (hasLiveLease) throw new CanvasRuntimeServiceError("content_out_of_sync");
      const authoritative = await this.options.contentTransfer.fetch(
        command.scope,
        target,
        active.controller.signal
      );
      this.assertOpen(command, active);
      await materializeAuthoritativeCanvasWorkspace({
        workspace: resolved.canvas,
        authorityProjectId: command.scope.projectId,
        content: authoritative.content
      });
      await this.writeMaterializedContentTarget(receiptFile, target);
    }
    await requireCanvasRuntimeMaterializationEvidence(resolved, {
      graphFingerprint: target.graphFingerprint,
      contentTarget: target
    });
  }

  private async readMaterializedContentTarget(
    path: string
  ): Promise<CanvasRuntimeContentTarget | undefined> {
    try {
      return canvasRuntimeContentTargetSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async writeMaterializedContentTarget(
    path: string,
    target: CanvasRuntimeContentTarget
  ): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(target, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async withMaterializationLock<T>(
    scope: CanvasRuntimeLogicalScope,
    resolved: ResolvedCanvasRuntime,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.withScopeLane(scope, () =>
      withAuthoritativeCanvasWorkspaceLock(resolved.canvas, operation)
    );
  }

  private async withScopeLane<T>(
    scope: CanvasRuntimeLogicalScope,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = `${scope.workspaceId}\u0000${scope.projectId}\u0000${scope.canvasId}`;
    const previous = this.materializationLocks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(
      () => turn,
      () => turn
    );
    this.materializationLocks.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.materializationLocks.get(key) === current) {
        this.materializationLocks.delete(key);
      }
    }
  }

  private async availability(resolved: ResolvedCanvasRuntime) {
    return readCanvasRuntimeAvailability(resolved);
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
      case "reset":
        return this.reset(command, resolved, lease, operation, active);
      default:
        throw new CanvasRuntimeServiceError("unsupported_canvas_runtime_operation");
    }
  }

  private async reset(
    command: CanvasRuntimeRequestCommand,
    resolved: ResolvedCanvasRuntime,
    lease: CanvasRuntimeLeaseRecord,
    operation: Extract<CanvasRuntimeRequestCommand["operation"], { operation: "reset" }>,
    active: ActiveRequest
  ) {
    const now = this.now().getTime();
    const conflicting = this.options.receipts
      .activeLeases(command.scope)
      .filter(
        (candidate) =>
          candidate.runtimeLeaseId !== lease.runtimeLeaseId && Date.parse(candidate.expiresAt) > now
      );
    if (conflicting.length > 0) {
      throw new CanvasRuntimeServiceError("active_lease");
    }
    const available = await this.availability(resolved);
    if (
      lease.sourceRevision !== operation.evidence.sourceRevision ||
      lease.graphFingerprint !== operation.evidence.graphFingerprint ||
      available.sourceRevision !== operation.evidence.sourceRevision ||
      available.graphFingerprint !== operation.evidence.graphFingerprint
    ) {
      throw new CanvasRuntimeServiceError("content_out_of_sync");
    }
    const { reason } = canvasRuntimeResetInputSchema.parse(operation.input);
    active.committed = true;
    try {
      await resetRuntimeState({
        projectRoot: resolved.canvas,
        force: true,
        reason,
        receipt: {
          operationId: operation.evidence.operationId,
          sourceRevision: operation.evidence.sourceRevision,
          graphFingerprint: operation.evidence.graphFingerprint,
          committedAt: this.now().toISOString()
        }
      });
    } catch (error) {
      if (error instanceof Error && /active work exists/i.test(error.message)) {
        throw new CanvasRuntimeServiceError("active_lease");
      }
      throw error;
    }
    const after = await this.availability(resolved);
    const result = canvasRuntimeResetResultSchema.parse({
      operationId: operation.evidence.operationId,
      sourceRevision: after.sourceRevision,
      graphFingerprint: after.graphFingerprint,
      status: after.status
    });
    this.options.receipts.resolveReset(command.scope, operation.evidence.operationId, {
      kind: "succeeded",
      result
    });
    return result;
  }

  private async resetStatus(
    command: CanvasRuntimeRequestCommand,
    resolved: ResolvedCanvasRuntime,
    status: CanvasRuntimeResetResolution
  ): Promise<CanvasRuntimeResetResolution> {
    if (command.operation.operation !== "reset_status") {
      throw new CanvasRuntimeServiceError("invalid_operation_input");
    }
    const operationId = command.operation.operationId;
    const original = this.options.receipts.resetOperation(command.scope, operationId);
    if (!original || this.active.has(original.requestId)) return status;
    return this.resolveInterruptedReset(original.command, resolved);
  }

  private async recoverInterruptedReset(command: CanvasRuntimeRequestCommand): Promise<void> {
    if (command.operation.operation !== "reset") return;
    const resetCommand = { ...command, operation: command.operation };
    let resolution: CanvasRuntimeResetResolution;
    try {
      const resolved = await this.options.resolver.resolve(resetCommand.scope);
      resolution = await this.resolveInterruptedReset(resetCommand, resolved);
    } catch {
      resolution = this.options.receipts.resolveReset(
        resetCommand.scope,
        resetCommand.operation.evidence.operationId,
        {
          kind: "failed",
          error: { code: "reset_recovery_unavailable", retryable: false }
        }
      );
    }
    if (resolution.kind === "succeeded") {
      this.options.receipts.complete(
        resetCommand.requestId,
        canvasRuntimeResponsePayloadSchema.parse({
          type: "canvas_runtime.response",
          protocolVersion: 1,
          requestId: resetCommand.requestId,
          response: { outcome: "success", operation: "reset", result: resolution.result }
        })
      );
      return;
    }
    if (resolution.kind === "failed") {
      this.finishError(
        resetCommand,
        new CanvasRuntimeServiceError(
          resolution.error.code,
          resolution.error.retryable,
          resolution.error.reconcileRequired === true
        ),
        resolution.error.reconcileRequired ? "reconcile_required" : "terminal"
      );
    }
  }

  private async resolveInterruptedReset(
    command: CanvasRuntimeRequestCommand & {
      operation: Extract<CanvasRuntimeRequestCommand["operation"], { operation: "reset" }>;
    },
    resolved: ResolvedCanvasRuntime
  ): Promise<CanvasRuntimeResetResolution> {
    const evidence = command.operation.evidence;
    const marker = await readRuntimeResetReceipt({ projectRoot: resolved.canvas });
    if (
      marker?.operationId === evidence.operationId &&
      marker.sourceRevision === evidence.sourceRevision &&
      marker.graphFingerprint === evidence.graphFingerprint
    ) {
      const after = await this.availability(resolved);
      if (
        after.sourceRevision === evidence.sourceRevision &&
        after.graphFingerprint === evidence.graphFingerprint &&
        after.status.packageFingerprint === evidence.graphFingerprint
      ) {
        return this.options.receipts.resolveReset(command.scope, evidence.operationId, {
          kind: "succeeded",
          result: canvasRuntimeResetResultSchema.parse({
            operationId: evidence.operationId,
            sourceRevision: after.sourceRevision,
            graphFingerprint: after.graphFingerprint,
            status: after.status
          })
        });
      }
      return this.options.receipts.resolveReset(command.scope, evidence.operationId, {
        kind: "failed",
        error: { code: "content_out_of_sync", retryable: false }
      });
    }
    return this.options.receipts.resolveReset(command.scope, evidence.operationId, {
      kind: "failed",
      error: { code: "reset_commit_not_observed", retryable: false }
    });
  }
}
