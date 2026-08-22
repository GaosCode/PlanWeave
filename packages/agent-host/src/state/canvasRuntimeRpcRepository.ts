import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizeJson,
  canvasRuntimeCancelCommandSchema,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeResponsePayloadSchema,
  canvasRuntimeResetStatusResultSchema,
  type CanvasRuntimeCancelCommand,
  type CanvasRuntimeRequestCommand,
  type CanvasRuntimeResponsePayload
} from "@planweave-ai/agent-host-protocol";
import { parseAgentHostEvent, type HostEvent } from "../protocol.js";
import { AgentHostEventOutbox } from "./agentHostEventOutbox.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqliteDatabase.js";

type CanvasRuntimeCommand = CanvasRuntimeRequestCommand | CanvasRuntimeCancelCommand;
type CanvasRuntimeResetCommand = CanvasRuntimeRequestCommand & {
  operation: Extract<CanvasRuntimeRequestCommand["operation"], { operation: "reset" }>;
};

export type CanvasRuntimeLeaseRecord = {
  runtimeLeaseId: string;
  workspaceId: string;
  projectId: string;
  canvasId: string;
  sourceRevision: string;
  graphFingerprint: string;
  status: "active" | "released";
  acquiredAt: string;
  expiresAt: string;
};

export type CanvasRuntimeReceiptAcceptance =
  | { kind: "accepted"; command: CanvasRuntimeCommand }
  | { kind: "in_flight" }
  | { kind: "replay"; response: CanvasRuntimeResponsePayload };

export type CanvasRuntimeResetResolution = ReturnType<
  typeof canvasRuntimeResetStatusResultSchema.parse
>;

function parseCommand(input: unknown): CanvasRuntimeCommand {
  const request = canvasRuntimeRequestCommandSchema.safeParse(input);
  if (request.success) return request.data;
  return canvasRuntimeCancelCommandSchema.parse(input);
}

function commandLeaseId(command: CanvasRuntimeCommand): string | null {
  return command.type === "canvas_runtime.request" && "runtimeLeaseId" in command.operation
    ? command.operation.runtimeLeaseId
    : null;
}

function commandOperation(command: CanvasRuntimeCommand): string {
  return command.type === "canvas_runtime.cancel" ? "cancel" : command.operation.operation;
}

function resetOperationIdentity(command: CanvasRuntimeCommand): {
  operationId: string | null;
  operationDigest: string | null;
} {
  if (command.type !== "canvas_runtime.request" || command.operation.operation !== "reset") {
    return { operationId: null, operationDigest: null };
  }
  return {
    operationId: command.operation.evidence.operationId,
    operationDigest: digest({
      scope: command.scope,
      evidence: command.operation.evidence,
      input: command.operation.input
    })
  };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeJson(value)).digest("hex")}`;
}

export class CanvasRuntimeRpcRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly events: AgentHostEventOutbox
  ) {}

  accept(input: CanvasRuntimeCommand, inboxSequence: number): CanvasRuntimeReceiptAcceptance {
    const command = parseCommand(input);
    const commandDigest = digest(command);
    const existing = this.database
      .prepare(
        `SELECT command_digest,status,response_json FROM canvas_runtime_rpc_receipts
         WHERE request_id=?`
      )
      .get(command.requestId);
    if (existing) {
      if (String(existing.command_digest) !== commandDigest) {
        throw new Error("canvas_runtime_request_identity_conflict");
      }
      if (existing.response_json) {
        const event = parseAgentHostEvent(JSON.parse(String(existing.response_json)));
        if (event.type !== "canvas_runtime.response") {
          throw new Error("canvas_runtime_receipt_response_invalid");
        }
        this.events.queue(`canvas-runtime.response:${command.requestId}`, event);
        const { messageId: _messageId, ...response } = event;
        return {
          kind: "replay",
          response: canvasRuntimeResponsePayloadSchema.parse(response)
        };
      }
      return { kind: "in_flight" };
    }
    const now = new Date().toISOString();
    const resetIdentity = resetOperationIdentity(command);
    if (resetIdentity.operationId) {
      const prior = this.database
        .prepare(
          `SELECT operation_digest FROM canvas_runtime_rpc_receipts
           WHERE workspace_id=? AND project_id=? AND canvas_id=?
             AND operation='reset' AND operation_id=?`
        )
        .get(
          command.scope.workspaceId,
          command.scope.projectId,
          command.scope.canvasId,
          resetIdentity.operationId
        );
      if (prior) {
        if (String(prior.operation_digest) !== resetIdentity.operationDigest) {
          throw new Error("canvas_runtime_reset_operation_identity_conflict");
        }
        throw new Error("canvas_runtime_reset_operation_already_recorded");
      }
    }
    this.database
      .prepare(
        `INSERT INTO canvas_runtime_rpc_receipts(
           request_id,inbox_sequence,lease_id,command_digest,command_json,workspace_id,project_id,canvas_id,
           operation,operation_id,operation_digest,status,received_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        command.requestId,
        inboxSequence,
        commandLeaseId(command),
        commandDigest,
        canonicalizeJson(command),
        command.scope.workspaceId,
        command.scope.projectId,
        command.scope.canvasId,
        commandOperation(command),
        resetIdentity.operationId,
        resetIdentity.operationDigest,
        "pending",
        now,
        now
      );
    return { kind: "accepted", command };
  }

  resetStatus(
    scope: { workspaceId: string; projectId: string; canvasId: string },
    operationId: string
  ) {
    const row = this.database
      .prepare(
        `SELECT status,response_json,reset_resolution_json FROM canvas_runtime_rpc_receipts
         WHERE workspace_id=? AND project_id=? AND canvas_id=?
           AND operation='reset' AND operation_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, operationId);
    if (!row) return canvasRuntimeResetStatusResultSchema.parse({ kind: "not_found" });
    if (row.reset_resolution_json) {
      return canvasRuntimeResetStatusResultSchema.parse(
        JSON.parse(String(row.reset_resolution_json))
      );
    }
    if (!row.response_json) return canvasRuntimeResetStatusResultSchema.parse({ kind: "pending" });
    const event = parseAgentHostEvent(JSON.parse(String(row.response_json)));
    if (event.type !== "canvas_runtime.response" || event.response.operation !== "reset") {
      throw new Error("canvas_runtime_reset_receipt_response_invalid");
    }
    if (event.response.outcome === "success") {
      return canvasRuntimeResetStatusResultSchema.parse({
        kind: "succeeded",
        result: event.response.result
      });
    }
    return canvasRuntimeResetStatusResultSchema.parse({
      kind: "failed",
      error: {
        code: event.response.error.code,
        retryable: event.response.error.retryable,
        ...(event.response.error.reconcileRequired === undefined
          ? {}
          : { reconcileRequired: event.response.error.reconcileRequired })
      }
    });
  }

  resetOperation(
    scope: { workspaceId: string; projectId: string; canvasId: string },
    operationId: string
  ): { requestId: string; command: CanvasRuntimeResetCommand } | undefined {
    const row = this.database
      .prepare(
        `SELECT request_id,command_json FROM canvas_runtime_rpc_receipts
         WHERE workspace_id=? AND project_id=? AND canvas_id=?
           AND operation='reset' AND operation_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, operationId);
    if (!row) return undefined;
    const command = canvasRuntimeRequestCommandSchema.parse(JSON.parse(String(row.command_json)));
    if (command.operation.operation !== "reset") {
      throw new Error("canvas_runtime_reset_receipt_command_invalid");
    }
    return {
      requestId: String(row.request_id),
      command: { ...command, operation: command.operation }
    };
  }

  resolveReset(
    scope: { workspaceId: string; projectId: string; canvasId: string },
    operationId: string,
    resolutionInput: CanvasRuntimeResetResolution
  ): CanvasRuntimeResetResolution {
    const resolution = canvasRuntimeResetStatusResultSchema.parse(resolutionInput);
    if (resolution.kind === "not_found" || resolution.kind === "pending") {
      throw new Error("canvas_runtime_reset_resolution_not_terminal");
    }
    const operation = this.resetOperation(scope, operationId);
    if (!operation) throw new Error("canvas_runtime_reset_receipt_not_found");
    if (
      resolution.kind === "succeeded" &&
      (resolution.result.operationId !== operationId ||
        resolution.result.sourceRevision !== operation.command.operation.evidence.sourceRevision ||
        resolution.result.graphFingerprint !==
          operation.command.operation.evidence.graphFingerprint)
    ) {
      throw new Error("canvas_runtime_reset_resolution_identity_mismatch");
    }
    return inWriteTransaction(this.database, () => {
      const row = this.database
        .prepare(
          `SELECT reset_resolution_json FROM canvas_runtime_rpc_receipts
           WHERE request_id=?`
        )
        .get(operation.requestId);
      if (!row) throw new Error("canvas_runtime_reset_receipt_not_found");
      if (row.reset_resolution_json) {
        const stored = canvasRuntimeResetStatusResultSchema.parse(
          JSON.parse(String(row.reset_resolution_json))
        );
        if (canonicalizeJson(stored) !== canonicalizeJson(resolution)) {
          throw new Error("canvas_runtime_reset_resolution_conflict");
        }
        return stored;
      }
      this.database
        .prepare(
          `UPDATE canvas_runtime_rpc_receipts
           SET reset_resolution_json=?,updated_at=? WHERE request_id=?`
        )
        .run(canonicalizeJson(resolution), new Date().toISOString(), operation.requestId);
      return resolution;
    });
  }

  begin(requestId: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE canvas_runtime_rpc_receipts SET status='running',updated_at=?
           WHERE request_id=? AND status='pending' AND response_json IS NULL`
        )
        .run(new Date().toISOString(), requestId).changes === 1
    );
  }

  complete(
    requestId: string,
    responseInput: CanvasRuntimeResponsePayload,
    status: "terminal" | "reconcile_required" = "terminal"
  ): HostEvent {
    const response = canvasRuntimeResponsePayloadSchema.parse(responseInput);
    if (response.requestId !== requestId)
      throw new Error("canvas_runtime_response_identity_mismatch");
    return inWriteTransaction(this.database, () => {
      const existing = this.database
        .prepare(
          "SELECT inbox_sequence,response_json FROM canvas_runtime_rpc_receipts WHERE request_id=?"
        )
        .get(requestId);
      if (!existing) throw new Error("canvas_runtime_receipt_not_found");
      if (existing.response_json) {
        const stored = parseAgentHostEvent(JSON.parse(String(existing.response_json)));
        if (stored.type !== "canvas_runtime.response") {
          throw new Error("canvas_runtime_receipt_response_invalid");
        }
        const { messageId: _storedMessageId, ...storedPayload } = stored;
        if (digest(storedPayload) !== digest(response)) {
          throw new Error("canvas_runtime_response_identity_conflict");
        }
        return this.events.queue(`canvas-runtime.response:${requestId}`, stored);
      }
      const event = parseAgentHostEvent({ ...response, messageId: randomUUID() });
      this.database
        .prepare(
          `UPDATE canvas_runtime_rpc_receipts
           SET status=?,response_json=?,updated_at=? WHERE request_id=?`
        )
        .run(status, canonicalizeJson(event), new Date().toISOString(), requestId);
      this.database
        .prepare("UPDATE agent_host_inbox SET processed_at=? WHERE sequence=?")
        .run(new Date().toISOString(), Number(existing.inbox_sequence));
      return this.events.queue(`canvas-runtime.response:${requestId}`, event);
    });
  }

  incomplete(): Array<{ command: CanvasRuntimeCommand; status: "pending" | "running" }> {
    return this.database
      .prepare(
        `SELECT command_json,status FROM canvas_runtime_rpc_receipts
         WHERE response_json IS NULL ORDER BY received_at ASC`
      )
      .all()
      .map((row) => ({
        command: parseCommand(JSON.parse(String(row.command_json))),
        status: String(row.status) as "pending" | "running"
      }));
  }

  createLease(record: CanvasRuntimeLeaseRecord): void {
    this.database
      .prepare(
        `INSERT INTO canvas_runtime_leases(
           lease_id,workspace_id,project_id,canvas_id,source_revision,graph_fingerprint,
           status,acquired_at,expires_at
         ) VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        record.runtimeLeaseId,
        record.workspaceId,
        record.projectId,
        record.canvasId,
        record.sourceRevision,
        record.graphFingerprint,
        record.status,
        record.acquiredAt,
        record.expiresAt
      );
  }

  lease(runtimeLeaseId: string): CanvasRuntimeLeaseRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT lease_id,workspace_id,project_id,canvas_id,source_revision,graph_fingerprint,
                status,acquired_at,expires_at
         FROM canvas_runtime_leases WHERE lease_id=?`
      )
      .get(runtimeLeaseId);
    if (!row) return undefined;
    return {
      runtimeLeaseId: String(row.lease_id),
      workspaceId: String(row.workspace_id),
      projectId: String(row.project_id),
      canvasId: String(row.canvas_id),
      sourceRevision: String(row.source_revision),
      graphFingerprint: String(row.graph_fingerprint),
      status: String(row.status) as "active" | "released",
      acquiredAt: String(row.acquired_at),
      expiresAt: String(row.expires_at)
    };
  }

  releaseLease(runtimeLeaseId: string, releasedAt = new Date().toISOString()): boolean {
    const row = this.database
      .prepare("SELECT status FROM canvas_runtime_leases WHERE lease_id=?")
      .get(runtimeLeaseId);
    if (!row) return false;
    if (row.status === "released") return true;
    this.database
      .prepare(`UPDATE canvas_runtime_leases SET status='released',released_at=? WHERE lease_id=?`)
      .run(releasedAt, runtimeLeaseId);
    return true;
  }

  activeLeases(scope: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
  }): CanvasRuntimeLeaseRecord[] {
    return this.database
      .prepare(
        `SELECT lease_id,workspace_id,project_id,canvas_id,source_revision,graph_fingerprint,
                status,acquired_at,expires_at
           FROM canvas_runtime_leases
          WHERE workspace_id=? AND project_id=? AND canvas_id=? AND status='active'`
      )
      .all(scope.workspaceId, scope.projectId, scope.canvasId)
      .map((row) => ({
        runtimeLeaseId: String(row.lease_id),
        workspaceId: String(row.workspace_id),
        projectId: String(row.project_id),
        canvasId: String(row.canvas_id),
        sourceRevision: String(row.source_revision),
        graphFingerprint: String(row.graph_fingerprint),
        status: "active" as const,
        acquiredAt: String(row.acquired_at),
        expiresAt: String(row.expires_at)
      }));
  }
}
