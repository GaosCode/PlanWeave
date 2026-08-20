import {
  CANVAS_RUNTIME_CAPABILITY,
  agentHostProtocolVersion,
  canvasRuntimeOperationSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeRequestIdSchema,
  canvasRuntimeResponseEventSchema,
  type CanvasRuntimeLogicalScope,
  type CanvasRuntimeOperation,
  type CanvasRuntimeResponsePayload
} from "@planweave-ai/agent-host-protocol";
import { randomUUID } from "node:crypto";
import type { AgentHostRepository } from "../hosts.js";
import { HostEventInbox } from "../hostEvents.js";
import type { DurableMailbox } from "../mailbox.js";
import type { HostEvent } from "../protocol.js";
import type { SqliteDatabase } from "../sqlite.js";
import type { CanvasRuntimeHostSessionLookup } from "./runtimeHostLocator.js";

type RuntimeResponse = CanvasRuntimeResponsePayload["response"];
type RuntimeResponseEvent = Extract<HostEvent, { type: "canvas_runtime.response" }>;

type PendingRequest = {
  hostId: string;
  operation: CanvasRuntimeOperation["operation"];
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
  "fail"
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
};

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
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
      throw new Error("canvas_runtime_rpc_timeout_invalid");
    }
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
    expectedAttachmentVersion?: number
  ): Promise<RuntimeResponse> {
    const operation = canvasRuntimeOperationSchema.parse(rawOperation);
    const mutation = mutationOperations.has(operation.operation);
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
    const deadline = new Date(this.clock().getTime() + this.options.requestTimeoutMs).toISOString();
    const command = canvasRuntimeRequestCommandSchema.parse({
      type: "canvas_runtime.request",
      protocolVersion: agentHostProtocolVersion,
      requestId,
      scope,
      deadline,
      operation
    });
    return new Promise<RuntimeResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        hostId,
        operation: operation.operation,
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
        }, this.options.requestTimeoutMs),
        resolve,
        reject
      };
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

  attachmentVersion(hostId: string): number {
    return this.attachmentVersions.get(hostId) ?? 0;
  }
}
