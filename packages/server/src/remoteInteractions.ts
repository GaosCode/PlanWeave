import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  interactionRequestSchema,
  historicalInteractionRequestSchema,
  historicalInteractionSettlementSchema,
  interactionSettlementSchema,
  parseInteractionSettlementForRequest,
  type HistoricalInteractionRequest,
  type HistoricalInteractionSettlement,
  type InteractionSettlement
} from "@planweave-ai/agent-host-protocol";
import { redactRunnerEventText } from "@planweave-ai/runtime";
import { z } from "zod";
import { enqueueExpiredLegacyPermissionCancellation } from "./remotePermissionExpiry.js";
import { HostEventInbox } from "./hostEvents.js";
import { DurableMailbox, type MailboxMessage } from "./mailbox.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

export type RemoteInteractionStatus = "pending" | "settled" | "expired";

export type RemoteInteractionIdentity = {
  hostId: string;
  dispatchId: string;
  executionAttemptId: string;
  acpSessionId: string;
  actionId: string;
};

export type RemoteInteractionRecord = {
  request: HistoricalInteractionRequest;
  operationId: string;
  hostId: string;
  status: RemoteInteractionStatus;
  createdAt: string;
  settlement?: HistoricalInteractionSettlement;
  settledBy?: string;
  settledAt?: string;
  mailboxMessageId?: string;
  expiryMailboxMessageId?: string;
};

export interface RemoteInteractionAuthorizationPort {
  canRespond(input: {
    responderId: string;
    workspaceId: string;
    projectId: string;
    operationId: string;
    actionId: string;
  }): boolean;
}

export interface RemoteInteractionPublisherPort {
  publish(message: MailboxMessage): void;
}

type RemoteInteractionServiceOptions = {
  authorization: RemoteInteractionAuthorizationPort;
  publisher?: RemoteInteractionPublisherPort;
  clock?: () => Date;
};

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}

function identityKey(identity: RemoteInteractionIdentity): string {
  return createHash("sha256").update(canonicalizeJson(identity)).digest("hex");
}

function requestIdentity(
  hostId: string,
  request: HistoricalInteractionRequest
): RemoteInteractionIdentity {
  return {
    hostId,
    dispatchId: request.dispatchId,
    executionAttemptId: request.executionAttemptId,
    acpSessionId: request.acpSessionId,
    actionId: request.actionId
  };
}

function redactRequest(request: HistoricalInteractionRequest): HistoricalInteractionRequest {
  switch (request.type) {
    case "interaction.permission_requested":
      return historicalInteractionRequestSchema.parse({
        ...request,
        title: redactRunnerEventText(request.title).text,
        description: redactRunnerEventText(request.description).text,
        ...("options" in request
          ? {
              options: request.options.map((option) => ({
                ...option,
                label: redactRunnerEventText(option.label).text
              }))
            }
          : {})
      });
    case "interaction.elicitation_requested":
      return historicalInteractionRequestSchema.parse({
        ...request,
        prompt: redactRunnerEventText(request.prompt).text,
        options: request.options.map((option) => redactRunnerEventText(option).text)
      });
    case "interaction.authentication_required":
      return historicalInteractionRequestSchema.parse({
        ...request,
        hostInstruction: redactRunnerEventText(request.hostInstruction).text
      });
  }
}

function toRecord(row: Record<string, unknown>): RemoteInteractionRecord {
  const request = historicalInteractionRequestSchema.parse(JSON.parse(String(row.request_json)));
  const settlement = row.settlement_json
    ? historicalInteractionSettlementSchema.parse(JSON.parse(String(row.settlement_json)))
    : undefined;
  if (
    request.actionId !== row.action_id ||
    request.dispatchId !== row.dispatch_id ||
    request.leaseId !== row.lease_id ||
    request.executionAttemptId !== row.execution_attempt_id ||
    request.acpSessionId !== row.acp_session_id ||
    fingerprint(request) !== row.request_fingerprint ||
    (settlement && fingerprint(settlement) !== row.settlement_fingerprint)
  ) {
    throw new Error("remote_interaction_row_identity_mismatch");
  }
  return {
    request,
    operationId: String(row.operation_id),
    hostId: String(row.host_id),
    status: z.enum(["pending", "settled", "expired"]).parse(row.status),
    createdAt: z.string().datetime().parse(row.created_at),
    settlement,
    settledBy: row.settled_by ? String(row.settled_by) : undefined,
    settledAt: row.settled_at ? z.string().datetime().parse(row.settled_at) : undefined,
    mailboxMessageId: row.mailbox_message_id ? String(row.mailbox_message_id) : undefined,
    expiryMailboxMessageId: row.expiry_mailbox_message_id
      ? String(row.expiry_mailbox_message_id)
      : undefined
  };
}

export class RemoteInteractionService {
  private readonly inbox: HostEventInbox;
  private readonly mailbox: DurableMailbox;
  private readonly clock: () => Date;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: RemoteInteractionServiceOptions
  ) {
    this.inbox = new HostEventInbox(database);
    this.mailbox = new DurableMailbox(database);
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Record a host interaction request. When the attempt is no longer active
   * (interrupt, expired lease, terminal status), the message is acknowledged
   * as a soft drop so the Host WS stays healthy; returns undefined.
   */
  recordRequest(
    hostId: string,
    messageId: string,
    rawRequest: unknown
  ): RemoteInteractionRecord | undefined {
    return this.recordParsedRequest(hostId, messageId, interactionRequestSchema.parse(rawRequest));
  }

  /** Compatibility intake only for a Host connection without exact permission support. */
  recordLegacyRequest(
    hostId: string,
    messageId: string,
    rawRequest: unknown
  ): RemoteInteractionRecord | undefined {
    return this.recordParsedRequest(
      hostId,
      messageId,
      historicalInteractionRequestSchema.parse(rawRequest)
    );
  }

  private recordParsedRequest(
    hostId: string,
    messageId: string,
    request: HistoricalInteractionRequest
  ): RemoteInteractionRecord | undefined {
    const redacted = redactRequest(request);
    let dropReason: "remote_interaction_attempt_not_active" | undefined;
    const applied = this.inbox.process(
      hostId,
      messageId,
      request.type,
      request.type === "interaction.permission_requested" && "options" in request
        ? redacted
        : request,
      () => {
        const identity = this.findActiveAttempt({ hostId, request });
        // Expected race after interrupt / lease change: drop without killing the Host WS.
        if (!identity) {
          dropReason = "remote_interaction_attempt_not_active";
          return;
        }
        const requestJson = canonicalizeJson(redacted);
        const existing = this.get(requestIdentity(hostId, redacted));
        if (existing) {
          if (existing.hostId !== hostId || canonicalizeJson(existing.request) !== requestJson) {
            throw new Error("remote_interaction_action_conflict");
          }
          return;
        }
        const now = this.clock().toISOString();
        this.database
          .prepare(
            `INSERT INTO remote_interactions(
            action_id,operation_id,host_id,dispatch_id,lease_id,execution_attempt_id,
            acp_session_id,request_type,request_fingerprint,request_json,status,
            expires_at,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
          )
          .run(
            redacted.actionId,
            identity.operationId,
            hostId,
            redacted.dispatchId,
            redacted.leaseId,
            redacted.executionAttemptId,
            redacted.acpSessionId,
            redacted.type,
            fingerprint(redacted),
            requestJson,
            redacted.expiresAt,
            now
          );
      }
    );
    if (dropReason) {
      console.warn(
        JSON.stringify({
          scope: "agent-host-ws",
          event: "remote_interaction_dropped",
          reason: dropReason,
          hostId,
          messageId,
          dispatchId: request.dispatchId,
          leaseId: request.leaseId,
          executionAttemptId: request.executionAttemptId,
          actionId: request.actionId
        })
      );
      return undefined;
    }
    // Idempotent retry of a previously soft-dropped request.
    if (!applied) {
      const existing = this.get(requestIdentity(hostId, request));
      if (!existing) return undefined;
      this.expireDue();
      return existing;
    }
    this.expireDue();
    return this.getRequired(requestIdentity(hostId, request));
  }

  settle(input: {
    hostId: string;
    responderId: string;
    settlement: unknown;
  }): RemoteInteractionRecord {
    const settlement = interactionSettlementSchema.parse(input.settlement);
    this.expireDue();
    const identity: RemoteInteractionIdentity = {
      hostId: input.hostId,
      dispatchId: settlement.dispatchId,
      executionAttemptId: settlement.executionAttemptId,
      acpSessionId: settlement.acpSessionId,
      actionId: settlement.actionId
    };
    const interaction = this.getRequired(identity);
    const operation = this.database
      .prepare("SELECT workspace_id,project_id FROM remote_operations WHERE id=?")
      .get(interaction.operationId);
    if (!operation || typeof operation.project_id !== "string") {
      throw new Error("remote_interaction_operation_not_found");
    }
    if (
      !this.options.authorization.canRespond({
        responderId: input.responderId,
        workspaceId: String(operation.workspace_id),
        projectId: operation.project_id,
        operationId: interaction.operationId,
        actionId: settlement.actionId
      })
    ) {
      throw new Error("remote_interaction_responder_unauthorized");
    }
    const parsedSettlement = parseInteractionSettlementForRequest(interaction.request, settlement);
    const settlementFingerprint = fingerprint(parsedSettlement);
    const message = inWriteTransaction(this.database, () => {
      const current = this.getRequired(identity);
      if (current.status === "expired") throw new Error("remote_interaction_expired");
      if (current.status === "settled") {
        if (
          current.settledBy !== input.responderId ||
          !current.settlement ||
          fingerprint(current.settlement) !== settlementFingerprint
        ) {
          throw new Error("remote_interaction_settlement_conflict");
        }
        if (!current.mailboxMessageId)
          throw new Error("remote_interaction_settlement_inconsistent");
        return this.mailbox
          .listAfter(current.hostId, 0)
          .find((candidate) => candidate.messageId === current.mailboxMessageId);
      }
      this.requireActiveAttempt({ hostId: input.hostId, request: current.request });
      const delivery = this.mailbox.enqueueOnce(
        `interaction-${identityKey(identity)}`,
        current.hostId,
        parsedSettlement
      ).message;
      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE remote_interactions
           SET status='settled',settlement_fingerprint=?,settlement_json=?,settled_by=?,
             settled_at=?,mailbox_message_id=?
           WHERE host_id=? AND dispatch_id=? AND execution_attempt_id=?
             AND acp_session_id=? AND action_id=? AND status='pending'`
        )
        .run(
          settlementFingerprint,
          canonicalizeJson(parsedSettlement),
          input.responderId,
          now,
          delivery.messageId,
          identity.hostId,
          identity.dispatchId,
          identity.executionAttemptId,
          identity.acpSessionId,
          identity.actionId
        );
      if (updated.changes !== 1) throw new Error("remote_interaction_settlement_conflict");
      return delivery;
    });
    if (!message) throw new Error("remote_interaction_settlement_inconsistent");
    if (!message.publishedAt && this.options.publisher) {
      this.options.publisher.publish(message);
      this.mailbox.markPublished(message.messageId);
    }
    return this.getRequired(identity);
  }

  expireDue(now = this.clock()): RemoteInteractionRecord[] {
    const identities = this.database
      .prepare(
        `SELECT host_id,dispatch_id,execution_attempt_id,acp_session_id,action_id
         FROM remote_interactions
         WHERE status='pending' AND expires_at<=? ORDER BY expires_at,action_id`
      )
      .all(now.toISOString())
      .map((row) => ({
        hostId: String(row.host_id),
        dispatchId: String(row.dispatch_id),
        executionAttemptId: String(row.execution_attempt_id),
        acpSessionId: String(row.acp_session_id),
        actionId: String(row.action_id)
      }));
    const expired: RemoteInteractionRecord[] = [];
    for (const identity of identities) {
      const message = inWriteTransaction(this.database, () => {
        const interaction = this.getRequired(identity);
        if (interaction.status !== "pending") return undefined;
        const legacyPermission =
          interaction.request.type === "interaction.permission_requested" &&
          !("options" in interaction.request);
        const command = legacyPermission ? undefined : this.expiryCommand(interaction.request);
        const legacyDelivery =
          legacyPermission &&
          this.findActiveAttempt({ hostId: interaction.hostId, request: interaction.request })
            ? enqueueExpiredLegacyPermissionCancellation(this.database, interaction, this.clock)
            : undefined;
        const delivery = command
          ? this.mailbox.enqueueOnce(
              `interaction-expiry-${identityKey(identity)}`,
              interaction.hostId,
              command
            ).message
          : legacyDelivery;
        const updated = this.database
          .prepare(
            `UPDATE remote_interactions SET status='expired',settled_at=?,
              expiry_mailbox_message_id=? WHERE host_id=? AND dispatch_id=?
                AND execution_attempt_id=? AND acp_session_id=? AND action_id=?
                AND status='pending'`
          )
          .run(
            now.toISOString(),
            delivery?.messageId ?? null,
            identity.hostId,
            identity.dispatchId,
            identity.executionAttemptId,
            identity.acpSessionId,
            identity.actionId
          );
        if (updated.changes !== 1) throw new Error("remote_interaction_expiry_conflict");
        return delivery;
      });
      if (message && !message.publishedAt && this.options.publisher) {
        this.options.publisher.publish(message);
        this.mailbox.markPublished(message.messageId);
      }
      expired.push(this.getRequired(identity));
    }
    return expired;
  }

  get(identity: RemoteInteractionIdentity): RemoteInteractionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM remote_interactions WHERE host_id=? AND dispatch_id=?
          AND execution_attempt_id=? AND acp_session_id=? AND action_id=?`
      )
      .get(
        identity.hostId,
        identity.dispatchId,
        identity.executionAttemptId,
        identity.acpSessionId,
        identity.actionId
      );
    return row ? toRecord(row) : undefined;
  }

  getRequired(identity: RemoteInteractionIdentity): RemoteInteractionRecord {
    const interaction = this.get(identity);
    if (!interaction) throw new Error("remote_interaction_not_found");
    return interaction;
  }

  listPending(operationId: string, limit = 100, offset = 0): RemoteInteractionRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
      throw new Error("remote_interaction_list_limit_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("remote_interaction_list_offset_invalid");
    }
    return this.database
      .prepare(
        `SELECT * FROM remote_interactions
         WHERE operation_id=? AND status='pending' ORDER BY created_at,action_id LIMIT ? OFFSET ?`
      )
      .all(operationId, limit, offset)
      .map(toRecord);
  }

  private findActiveAttempt(input: {
    hostId: string;
    request: HistoricalInteractionRequest;
  }): { operationId: string } | undefined {
    const row = this.database
      .prepare(
        `SELECT a.operation_id,a.dispatch_id,a.host_id,a.lease_id,a.status AS attempt_status,
           r.status AS reservation_status,d.status AS dispatch_status,
           d.host_id AS dispatch_host_id,d.lease_id AS dispatch_lease_id,
           d.execution_attempt_id AS dispatch_attempt_id, d.lease_expires_at AS dispatch_lease_expires_at
         FROM remote_execution_attempts a
         JOIN host_capacity_reservations r ON r.lease_id=a.lease_id
         JOIN dispatches d ON d.id=a.dispatch_id
         WHERE a.execution_attempt_id=?`
      )
      .get(input.request.executionAttemptId);
    if (
      !row ||
      row.dispatch_id !== input.request.dispatchId ||
      row.host_id !== input.hostId ||
      row.lease_id !== input.request.leaseId ||
      row.reservation_status !== "active" ||
      row.dispatch_host_id !== input.hostId ||
      row.dispatch_lease_id !== input.request.leaseId ||
      row.dispatch_attempt_id !== input.request.executionAttemptId ||
      String(row.dispatch_lease_expires_at) <= this.clock().toISOString() ||
      !["activated", "running"].includes(String(row.attempt_status)) ||
      !["leased", "running", "cancelling"].includes(String(row.dispatch_status))
    ) {
      return undefined;
    }
    return { operationId: String(row.operation_id) };
  }

  private requireActiveAttempt(input: { hostId: string; request: HistoricalInteractionRequest }): {
    operationId: string;
  } {
    const identity = this.findActiveAttempt(input);
    if (!identity) throw new Error("remote_interaction_attempt_not_active");
    return identity;
  }

  private expiryCommand(request: HistoricalInteractionRequest): InteractionSettlement | undefined {
    switch (request.type) {
      case "interaction.permission_requested":
        return interactionSettlementSchema.parse({
          type: "interaction.permission_response",
          dispatchId: request.dispatchId,
          leaseId: request.leaseId,
          executionAttemptId: request.executionAttemptId,
          actionId: request.actionId,
          acpSessionId: request.acpSessionId,
          decision: "deny"
        });
      case "interaction.authentication_required":
        return interactionSettlementSchema.parse({
          type: "interaction.authentication_action",
          dispatchId: request.dispatchId,
          leaseId: request.leaseId,
          executionAttemptId: request.executionAttemptId,
          actionId: request.actionId,
          acpSessionId: request.acpSessionId,
          action: "cancel"
        });
      case "interaction.elicitation_requested":
        return interactionSettlementSchema.parse({
          type: "interaction.elicitation_response",
          dispatchId: request.dispatchId,
          leaseId: request.leaseId,
          executionAttemptId: request.executionAttemptId,
          actionId: request.actionId,
          acpSessionId: request.acpSessionId,
          outcome: "cancelled"
        });
    }
  }
}
