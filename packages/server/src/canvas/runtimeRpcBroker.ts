import {
  CANVAS_RUNTIME_CAPABILITY,
  agentHostProtocolVersion,
  canvasRuntimeCancelCommandSchema,
  canvasRuntimeOperationSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeRequestIdSchema,
  canvasRuntimeResponseEventSchema,
  type CanvasRuntimeLogicalScope,
  type CanvasRuntimeOperation,
  type CanvasRuntimeRequestCommand,
  type CanvasRuntimeResponsePayload
} from "@planweave-ai/agent-host-protocol";
import {
  canvasRuntimeContentTargetSchema,
  type CanvasRuntimeContentTarget,
  type CompletedContentVersionRef
} from "@planweave-ai/collaboration-protocol/content/version";
import type { CanvasScopeRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { randomUUID } from "node:crypto";
import type { AgentHostRepository } from "../hosts.js";
import { HostEventInbox } from "../hostEvents.js";
import type { DurableMailbox } from "../mailbox.js";
import type { HostEvent } from "../protocol.js";
import type { SqliteDatabase } from "../sqlite.js";
import type { CanvasRuntimeHostSessionLookup } from "./runtimeHostLocator.js";

type RuntimeResponse = CanvasRuntimeResponsePayload["response"];
type RuntimeResponseEvent = Extract<HostEvent, { type: "canvas_runtime.response" }>;
type CancellableReadOperation = Extract<
  CanvasRuntimeOperation,
  { operation: "availability" | "resolve_work_items" }
>;

type PendingRequest = {
  hostId: string;
  scope: CanvasRuntimeLogicalScope;
  operation: CanvasRuntimeOperation["operation"];
  contentTarget?: CanvasRuntimeContentTarget;
  mutation: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(response: RuntimeResponse): void;
  reject(error: Error): void;
};

const mutationOperations = new Set<CanvasRuntimeOperation["operation"]>([
  "claim",
  "activate",
  "mark_interrupted",
  "resume_attempt",
  "retry_attempt",
  "complete",
  "fail",
  "reset"
]);

const cancellableReadOperations = new Set<CanvasRuntimeOperation["operation"]>([
  "availability",
  "resolve_work_items"
]);

export class CanvasRuntimeRpcError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly reconcileRequired: boolean
  ) {
    super(code);
    this.name = "CanvasRuntimeRpcError";
  }
}

export type CanvasRuntimeRpcBrokerOptions = {
  requestTimeoutMs: number;
  clock?: () => Date;
  diagnosticSink?: CanvasRuntimeRpcDiagnosticSink;
};

export type CanvasRuntimeRpcRequestOptions = {
  requestTimeoutMs?: number;
};

export type CanvasRuntimeRpcDiagnostic = {
  hostId: string;
  operation: CancellableReadOperation["operation"];
  category: "cancel_publish_failed";
  code: "canvas_runtime_cancel_publish_failed";
};

export type CanvasRuntimeRpcDiagnosticSink = (diagnostic: CanvasRuntimeRpcDiagnostic) => void;

export type CanvasRuntimeRpcReadHandle = {
  response: Promise<RuntimeResponse>;
  cancel(): boolean;
};

type InternalRequestHandle = CanvasRuntimeRpcReadHandle;

function parseRequestTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("canvas_runtime_rpc_timeout_invalid");
  }
  return value;
}

function logCanvasRuntimeRpcDiagnostic(diagnostic: CanvasRuntimeRpcDiagnostic): void {
  console.warn("canvas_runtime_rpc_diagnostic", diagnostic);
}

/** Correlates durable Runtime RPC requests while the existing WS owns session truth. */
export class CanvasRuntimeRpcBroker implements CanvasRuntimeHostSessionLookup {
  private readonly inbox: HostEventInbox;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly attachmentVersions = new Map<string, number>();
  private readonly clock: () => Date;
  private sessionLookup: CanvasRuntimeHostSessionLookup | undefined;

  constructor(
    database: SqliteDatabase,
    private readonly hosts: AgentHostRepository,
    private readonly mailbox: DurableMailbox,
    private readonly options: CanvasRuntimeRpcBrokerOptions
  ) {
    parseRequestTimeoutMs(options.requestTimeoutMs);
    this.inbox = new HostEventInbox(database);
    this.clock = options.clock ?? (() => new Date());
  }

  attachSessionLookup(lookup: CanvasRuntimeHostSessionLookup): void {
    if (this.sessionLookup) throw new Error("canvas_runtime_session_lookup_already_attached");
    this.sessionLookup = lookup;
  }

  isActive(hostId: string): boolean {
    const host = this.hosts.get(hostId);
    return (
      host !== undefined &&
      host.revokedAt === undefined &&
      host.capabilities.includes(CANVAS_RUNTIME_CAPABILITY) &&
      this.sessionLookup?.isActive(hostId) === true
    );
  }

  async request(
    hostId: string,
    scope: CanvasRuntimeLogicalScope,
    rawOperation: CanvasRuntimeOperation,
    expectedAttachmentVersion?: number,
    requestOptions: CanvasRuntimeRpcRequestOptions = {}
  ): Promise<RuntimeResponse> {
    return this.startRequest(
      hostId,
      scope,
      canvasRuntimeOperationSchema.parse(rawOperation),
      expectedAttachmentVersion,
      requestOptions
    ).response;
  }

  requestCancellableRead(
    hostId: string,
    scope: CanvasRuntimeLogicalScope,
    rawOperation: CancellableReadOperation,
    expectedAttachmentVersion?: number,
    requestOptions: CanvasRuntimeRpcRequestOptions = {}
  ): CanvasRuntimeRpcReadHandle {
    const operation = canvasRuntimeOperationSchema.parse(rawOperation);
    if (!cancellableReadOperations.has(operation.operation)) {
      throw new Error("canvas_runtime_rpc_cancellation_unsupported");
    }
    return this.startRequest(hostId, scope, operation, expectedAttachmentVersion, requestOptions);
  }

  private startRequest(
    hostId: string,
    scope: CanvasRuntimeLogicalScope,
    operation: CanvasRuntimeOperation,
    expectedAttachmentVersion: number | undefined,
    requestOptions: CanvasRuntimeRpcRequestOptions
  ): InternalRequestHandle {
    const mutation = mutationOperations.has(operation.operation);
    const requestTimeoutMs = parseRequestTimeoutMs(
      requestOptions.requestTimeoutMs ?? this.options.requestTimeoutMs
    );
    if (
      !this.isActive(hostId) ||
      (expectedAttachmentVersion !== undefined &&
        expectedAttachmentVersion !== this.attachmentVersion(hostId))
    ) {
      throw new CanvasRuntimeRpcError(
        mutation ? "canvas_runtime_reconcile_required" : "canvas_runtime_host_offline",
        true,
        mutation
      );
    }
    const requestId = canvasRuntimeRequestIdSchema.parse(randomUUID());
    const deadline = new Date(this.clock().getTime() + requestTimeoutMs).toISOString();
    const command = canvasRuntimeRequestCommandSchema.parse({
      type: "canvas_runtime.request",
      protocolVersion: agentHostProtocolVersion,
      requestId,
      scope,
      deadline,
      operation
    });
    let capturedPending: PendingRequest | undefined;
    const response = new Promise<RuntimeResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        hostId,
        scope,
        operation: operation.operation,
        ...("contentTarget" in operation
          ? { contentTarget: canvasRuntimeContentTargetSchema.parse(operation.contentTarget) }
          : {}),
        mutation,
        timer: setTimeout(() => {
          if (this.pending.delete(requestId)) {
            reject(
              new CanvasRuntimeRpcError(
                pending.mutation
                  ? "canvas_runtime_reconcile_required"
                  : "canvas_runtime_rpc_deadline_exceeded",
                true,
                pending.mutation
              )
            );
          }
        }, requestTimeoutMs),
        resolve,
        reject
      };
      capturedPending = pending;
      this.pending.set(requestId, pending);
      try {
        const message = this.mailbox.enqueue(hostId, command);
        this.mailbox.publish(message);
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error("canvas_runtime_rpc_publish_failed"));
      }
    });
    return {
      response,
      cancel: () => {
        const pending = capturedPending;
        if (!pending || this.pending.get(requestId) !== pending) return false;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new CanvasRuntimeRpcError("canvas_runtime_rpc_cancelled", false, false));
        this.publishCancellation(pending.hostId, command, requestTimeoutMs);
        return true;
      }
    };
  }

  private publishCancellation(
    hostId: string,
    target: CanvasRuntimeRequestCommand,
    requestTimeoutMs: number
  ): void {
    const operation = target.operation.operation;
    if (operation !== "availability" && operation !== "resolve_work_items") {
      throw new Error("canvas_runtime_rpc_cancellation_unsupported");
    }
    const command = canvasRuntimeCancelCommandSchema.parse({
      type: "canvas_runtime.cancel",
      protocolVersion: agentHostProtocolVersion,
      requestId: canvasRuntimeRequestIdSchema.parse(randomUUID()),
      targetRequestId: target.requestId,
      scope: target.scope,
      deadline: new Date(this.clock().getTime() + requestTimeoutMs).toISOString()
    });
    try {
      const message = this.mailbox.enqueue(hostId, command);
      this.mailbox.publish(message);
    } catch {
      this.reportDiagnostic({
        hostId,
        operation,
        category: "cancel_publish_failed",
        code: "canvas_runtime_cancel_publish_failed"
      });
    }
  }

  private reportDiagnostic(diagnostic: CanvasRuntimeRpcDiagnostic): void {
    try {
      (this.options.diagnosticSink ?? logCanvasRuntimeRpcDiagnostic)(diagnostic);
    } catch {
      // Diagnostics are observational and cannot prevent local request cancellation.
    }
  }

  handleResponse(hostId: string, rawEvent: RuntimeResponseEvent): boolean {
    const event = canvasRuntimeResponseEventSchema.parse(rawEvent);
    return this.inbox.process(hostId, rawEvent.messageId, event.type, event, () => {
      const pending = this.pending.get(event.requestId);
      if (!pending) return;
      if (pending.hostId !== hostId || event.response.operation !== pending.operation) {
        clearTimeout(pending.timer);
        this.pending.delete(event.requestId);
        pending.reject(
          new CanvasRuntimeRpcError(
            pending.mutation
              ? "canvas_runtime_reconcile_required"
              : pending.hostId !== hostId
                ? "canvas_runtime_response_host_mismatch"
                : "canvas_runtime_response_operation_mismatch",
            false,
            pending.mutation
          )
        );
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(event.requestId);
      pending.resolve(event.response);
    });
  }

  detachHost(hostId: string, reason: "disconnected" | "superseded" | "revoked"): void {
    this.attachmentVersions.set(hostId, this.attachmentVersion(hostId) + 1);
    for (const [requestId, pending] of this.pending) {
      if (pending.hostId !== hostId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(
        new CanvasRuntimeRpcError(
          pending.mutation ? "canvas_runtime_reconcile_required" : `canvas_runtime_host_${reason}`,
          true,
          pending.mutation
        )
      );
    }
  }

  close(): void {
    for (const hostId of new Set([...this.pending.values()].map(({ hostId }) => hostId))) {
      this.detachHost(hostId, "disconnected");
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  authorizesContentTransfer(
    hostId: string,
    scope: CanvasScopeRef,
    content: CompletedContentVersionRef
  ): boolean {
    return [...this.pending.values()].some(
      (pending) =>
        pending.hostId === hostId &&
        pending.scope.workspaceId === scope.workspaceId &&
        pending.scope.projectId === scope.projectId &&
        pending.scope.canvasId === scope.canvasId &&
        pending.contentTarget?.content.versionId === content.versionId &&
        pending.contentTarget.content.canonicalDigest === content.canonicalDigest
    );
  }

  attachmentVersion(hostId: string): number {
    return this.attachmentVersions.get(hostId) ?? 0;
  }
}
