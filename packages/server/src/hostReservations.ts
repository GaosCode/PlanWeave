import { leaseIdSchema, opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { capabilitiesSchema } from "./protocol.js";
import { RemoteOperationRepository } from "./remoteOperations.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import {
  AgentHostRepository,
  fleetHostExecutionProfileAvailability,
  isAgentHostOnline
} from "./hosts.js";
import { isOwnerCanvasRuntime } from "./endpointSelection.js";
import { occupiesHostCapacity } from "./remoteAgent/dispatchTarget.js";
import type { RemoteOperation } from "./remoteOperations.js";

const capacityManagedReservationSql = `
  NOT EXISTS (
    SELECT 1
    FROM remote_execution_attempts capacity_attempt
    JOIN remote_operations capacity_operation
      ON capacity_operation.id=capacity_attempt.operation_id
    WHERE capacity_attempt.execution_attempt_id=r.execution_attempt_id
      AND (
        json_extract(
          capacity_operation.endpoint_selection_json,
          '$.authority.kind'
        )='owner_canvas'
        OR json_extract(
          capacity_operation.endpoint_selection_json,
          '$.authority.controlPlane'
        )='owner'
      )
  )
`;

function reservationOccupiesHostCapacity(operation: RemoteOperation): boolean {
  if (operation.agentAccess) {
    return occupiesHostCapacity(operation.agentAccess.authorized);
  }
  return !isOwnerCanvasRuntime(operation.endpointSelection?.authority);
}

const timestampSchema = z.iso.datetime();
const hostCandidateRowSchema = z
  .object({
    id: opaqueIdentifierSchema,
    capabilities_json: z.string(),
    capacity: z.number().int().min(1).max(128),
    last_seen_at: timestampSchema,
    active_reservations: z.number().int().nonnegative()
  })
  .strict();

const activeReservationCountRowSchema = z
  .object({
    host_id: opaqueIdentifierSchema,
    active_reservations: z.number().int().nonnegative()
  })
  .strict();

export const reservationStatusSchema = z.enum(["active", "released", "expired", "cancelled"]);
export const reservationReleaseReasonSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
  "expired"
]);
export const activeAttemptTransitionSchema = z.enum([
  "activated",
  "running",
  "interrupted",
  "action_required",
  "awaiting_writeback"
]);

const reservationRowSchema = z
  .object({
    lease_id: leaseIdSchema,
    execution_attempt_id: opaqueIdentifierSchema,
    host_id: opaqueIdentifierSchema,
    fencing_token: z.number().int().positive(),
    status: reservationStatusSchema,
    lease_expires_at: timestampSchema,
    version: z.number().int().nonnegative(),
    created_at: timestampSchema,
    released_at: timestampSchema.nullable()
  })
  .strict();

export type HostCapacityReservation = {
  leaseId: string;
  executionAttemptId: string;
  hostId: string;
  fencingToken: number;
  status: z.infer<typeof reservationStatusSchema>;
  leaseExpiresAt: string;
  version: number;
  createdAt: string;
  releasedAt?: string;
};

export type HostReservationRepositoryOptions = {
  hostOfflineAfterMs: number;
  leaseDurationMs: number;
  clock?: () => Date;
};

function attemptEventForRelease(reason: z.infer<typeof reservationReleaseReasonSchema>) {
  if (reason === "expired") return "remote.attempt.interrupted" as const;
  if (reason === "completed") return "remote.attempt.completed" as const;
  if (reason === "failed") return "remote.attempt.failed" as const;
  return "remote.attempt.cancelled" as const;
}

function reservationEventForRelease(reason: z.infer<typeof reservationReleaseReasonSchema>) {
  if (reason === "expired") return "remote.reservation.expired" as const;
  if (reason === "cancelled") return "remote.reservation.cancelled" as const;
  return "remote.reservation.released" as const;
}

const reservationColumns = `
  lease_id,execution_attempt_id,host_id,fencing_token,status,lease_expires_at,
  version,created_at,released_at
`;

function toReservation(row: Record<string, unknown>): HostCapacityReservation {
  try {
    const parsed = reservationRowSchema.parse(row);
    return {
      leaseId: parsed.lease_id,
      executionAttemptId: parsed.execution_attempt_id,
      hostId: parsed.host_id,
      fencingToken: parsed.fencing_token,
      status: parsed.status,
      leaseExpiresAt: parsed.lease_expires_at,
      version: parsed.version,
      createdAt: parsed.created_at,
      releasedAt: parsed.released_at ?? undefined
    };
  } catch (error) {
    throw new Error("host_reservation_row_invalid", { cause: error });
  }
}

export class HostReservationRepository {
  private readonly clock: () => Date;
  private readonly hosts: AgentHostRepository;
  private readonly workspaceIdentity: WorkspaceIdentityRepository;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: HostReservationRepositoryOptions
  ) {
    if (!Number.isInteger(options.hostOfflineAfterMs) || options.hostOfflineAfterMs < 1_000) {
      throw new Error("hostOfflineAfterMs must be an integer of at least 1000.");
    }
    if (!Number.isInteger(options.leaseDurationMs) || options.leaseDurationMs < 1_000) {
      throw new Error("leaseDurationMs must be an integer of at least 1000.");
    }
    this.clock = options.clock ?? (() => new Date());
    this.hosts = new AgentHostRepository(database, this.clock);
    this.workspaceIdentity = new WorkspaceIdentityRepository(database);
  }

  /**
   * Materialize the Server-owned lease identity used by a same-attempt resume.
   * The identity is persisted with the action before reservation application; the
   * reservation transition later reuses this exact expiry and fencing identity.
   */
  createResumeLease(): { leaseId: string; leaseExpiresAt: string } {
    const now = this.clock();
    return {
      leaseId: leaseIdSchema.parse(`lease-${randomUUID()}`),
      leaseExpiresAt: new Date(now.getTime() + this.options.leaseDurationMs).toISOString()
    };
  }

  /** Snapshot collaboration-capacity reservations for a specific Host set in one query. */
  activeCountsForHosts(hostIds: readonly string[]): ReadonlyMap<string, number> {
    const ids = [...new Set(hostIds.map((hostId) => opaqueIdentifierSchema.parse(hostId)))];
    const counts = new Map(ids.map((hostId) => [hostId, 0]));
    if (ids.length === 0) return counts;
    const rows = this.database
      .prepare(
        `SELECT r.host_id,COUNT(*) AS active_reservations
         FROM host_capacity_reservations r
         WHERE r.status='active'
           AND r.host_id IN (SELECT value FROM json_each(?))
           AND ${capacityManagedReservationSql}
         GROUP BY r.host_id`
      )
      .all(JSON.stringify(ids));
    for (const row of rows) {
      const parsed = activeReservationCountRowSchema.parse(row);
      counts.set(parsed.host_id, parsed.active_reservations);
    }
    return counts;
  }

  /**
   * Reserve a Host for an operation attempt. Workspace canvas and restricted
   * Endpoint runs consume advertised Host capacity. Owner-canvas fleet runs may
   * still search the owner fleet, but they do not consume collaboration capacity.
   * When `preferredHostId` is set (exact Host assignment or explicit override), only that Host
   * is considered — never an arbitrary alternate from a UI eligibility cache.
   * When omitted, uses the deterministic automatic selector (active_reservations ASC,
   * last_seen_at DESC, id ASC) against authoritative operation.requiredCapabilities.
   */
  reserve(
    operationId: string,
    options: { agentId: string; agentProfileId: string; preferredHostId?: string }
  ): HostCapacityReservation {
    try {
      return inWriteTransaction(this.database, () => {
        const operation = new RemoteOperationRepository(this.database, this.clock).getRequired(
          operationId
        );
        if (
          operation.attempt.status !== "prepared" ||
          (operation.state !== "preparing" && operation.state !== "claimed")
        ) {
          const existing = operation.attempt.leaseId
            ? this.get(operation.attempt.leaseId)
            : undefined;
          if (existing?.status === "active") return existing;
          throw new Error("remote_attempt_not_reservable");
        }
        const now = this.clock();
        const onlineAfter = new Date(now.getTime() - this.options.hostOfflineAfterMs).toISOString();
        const occupiesCapacity = reservationOccupiesHostCapacity(operation);
        const preferredHostId =
          options.preferredHostId === undefined
            ? undefined
            : opaqueIdentifierSchema.parse(options.preferredHostId);
        const candidates = (
          preferredHostId
            ? this.database
                .prepare(
                  `SELECT h.id,h.capabilities_json,h.capacity,h.last_seen_at,
                    (SELECT COUNT(*) FROM host_capacity_reservations r
                      WHERE r.host_id=h.id AND r.status='active'
                        AND ${capacityManagedReservationSql}) AS active_reservations
                   FROM agent_hosts h
                   WHERE h.id=? AND h.revoked_at IS NULL AND h.last_seen_at>=?
                     AND (h.credential_expires_at IS NULL OR h.credential_expires_at>?)`
                )
                .all(preferredHostId, onlineAfter, now.toISOString())
            : this.database
                .prepare(
                  `SELECT h.id,h.capabilities_json,h.capacity,h.last_seen_at,
                    (SELECT COUNT(*) FROM host_capacity_reservations r
                      WHERE r.host_id=h.id AND r.status='active'
                        AND ${capacityManagedReservationSql}) AS active_reservations
                   FROM agent_hosts h
                   WHERE h.revoked_at IS NULL AND h.last_seen_at>=?
                     AND (h.credential_expires_at IS NULL OR h.credential_expires_at>?)
                   ORDER BY active_reservations ASC,h.last_seen_at DESC,h.id ASC`
                )
                .all(onlineAfter, now.toISOString())
        )
          .map((row) => {
            try {
              const parsed = hostCandidateRowSchema.parse(row);
              return {
                ...parsed,
                capabilities: capabilitiesSchema.parse(JSON.parse(parsed.capabilities_json))
              };
            } catch (error) {
              throw new Error("agent_host_row_invalid", { cause: error });
            }
          })
          .filter((candidate) => {
            const host = this.hosts.get(candidate.id);
            if (!host) return false;
            const online = isAgentHostOnline(host, {
              now,
              hostOfflineAfterMs: this.options.hostOfflineAfterMs
            });
            const profileAvailability = fleetHostExecutionProfileAvailability(host, {
              online,
              agentId: options.agentId,
              agentProfileId: options.agentProfileId,
              requiredCapabilities: operation.requiredCapabilities
            });
            return (
              this.workspaceIdentity.hostUsable(candidate.id, now) &&
              profileAvailability.status === "available"
            );
          });
        const required = new Set(operation.requiredCapabilities);
        const host = candidates.find(
          (candidate) =>
            (!occupiesCapacity || candidate.active_reservations < candidate.capacity) &&
            [...required].every((capability) => candidate.capabilities.includes(capability))
        );
        if (!host) throw new Error("no_compatible_agent_host");

        const leaseId = leaseIdSchema.parse(`lease-${randomUUID()}`);
        const fencingToken = 1;
        const leaseExpiresAt = new Date(now.getTime() + this.options.leaseDurationMs).toISOString();
        this.database
          .prepare(
            `UPDATE remote_execution_attempts
             SET status='reserved',host_id=?,lease_id=?,lease_fencing_token=?,lease_expires_at=?,
               state_version=state_version+1,updated_at=?
             WHERE execution_attempt_id=? AND status='prepared' AND state_version=?`
          )
          .run(
            host.id,
            leaseId,
            fencingToken,
            leaseExpiresAt,
            now.toISOString(),
            operation.executionAttemptId,
            operation.attempt.stateVersion
          );
        this.database
          .prepare(
            `INSERT INTO host_capacity_reservations(
              lease_id,execution_attempt_id,host_id,fencing_token,status,lease_expires_at,created_at
            ) VALUES (?,?,?,?,'active',?,?)`
          )
          .run(
            leaseId,
            operation.executionAttemptId,
            host.id,
            fencingToken,
            leaseExpiresAt,
            now.toISOString()
          );
        this.database
          .prepare("UPDATE remote_operations SET state='reserved',updated_at=? WHERE id=?")
          .run(now.toISOString(), operation.id);
        new RemoteOperationRepository(this.database, this.clock).appendEvent(
          operation.id,
          operation.executionAttemptId,
          "remote.attempt.reserved",
          now.toISOString()
        );
        return this.getRequired(leaseId);
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: remote_execution_attempts\.(workspace_id|project_id|canvas_id|block_ref|ownership_generation)/.test(
          error.message
        )
      ) {
        throw new Error("remote_active_attempt_conflict", { cause: error });
      }
      throw error;
    }
  }

  get(leaseId: string): HostCapacityReservation | undefined {
    const row = this.database
      .prepare(`SELECT ${reservationColumns} FROM host_capacity_reservations WHERE lease_id=?`)
      .get(leaseId);
    return row ? toReservation(row) : undefined;
  }

  getRequired(leaseId: string): HostCapacityReservation {
    const reservation = this.get(leaseId);
    if (!reservation) throw new Error("host_reservation_not_found");
    return reservation;
  }

  isActiveForAttempt(input: {
    leaseId: string;
    executionAttemptId: string;
    hostId: string;
  }): boolean {
    const reservation = this.getRequired(input.leaseId);
    return (
      reservation.executionAttemptId === input.executionAttemptId &&
      reservation.hostId === input.hostId &&
      reservation.status === "active" &&
      Date.parse(reservation.leaseExpiresAt) > this.clock().getTime()
    );
  }

  expireDue(now = this.clock()): HostCapacityReservation[] {
    const leaseIds = this.database
      .prepare(
        `SELECT lease_id FROM host_capacity_reservations
         WHERE status='active' AND lease_expires_at<=? ORDER BY lease_expires_at,lease_id`
      )
      .all(now.toISOString())
      .map((row) => leaseIdSchema.parse(row.lease_id));
    const expired: HostCapacityReservation[] = [];
    for (const leaseId of leaseIds) {
      const reservation = this.getRequired(leaseId);
      if (
        reservation.status !== "active" ||
        Date.parse(reservation.leaseExpiresAt) > now.getTime()
      ) {
        continue;
      }
      expired.push(
        this.release({
          leaseId,
          fencingToken: reservation.fencingToken,
          expectedVersion: reservation.version,
          reason: "expired"
        })
      );
    }
    return expired;
  }

  resumeSameAttempt(input: {
    priorLeaseId: string;
    leaseId: string;
    leaseExpiresAt: string;
    expectedAttemptVersion: number;
  }): HostCapacityReservation {
    const priorLeaseId = leaseIdSchema.parse(input.priorLeaseId);
    const leaseId = leaseIdSchema.parse(input.leaseId);
    const leaseExpiresAt = timestampSchema.parse(input.leaseExpiresAt);
    if (priorLeaseId === leaseId) throw new Error("remote_resume_lease_identity_reused");
    return inWriteTransaction(this.database, () => {
      const prior = this.getRequired(priorLeaseId);
      const existing = this.get(leaseId);
      if (existing) {
        if (
          existing.executionAttemptId === prior.executionAttemptId &&
          existing.hostId === prior.hostId &&
          existing.fencingToken === prior.fencingToken + 1 &&
          existing.status === "active" &&
          existing.leaseExpiresAt === leaseExpiresAt
        ) {
          return existing;
        }
        throw new Error("remote_resume_lease_identity_conflict");
      }
      if (prior.status !== "expired") throw new Error("remote_resume_prior_lease_not_fenced");
      const now = this.clock();
      const expiryTime = Date.parse(leaseExpiresAt);
      if (
        expiryTime <= now.getTime() ||
        expiryTime > now.getTime() + this.options.leaseDurationMs
      ) {
        throw new Error("remote_resume_lease_expiry_invalid");
      }
      const operationRow = this.database
        .prepare("SELECT operation_id FROM remote_execution_attempts WHERE execution_attempt_id=?")
        .get(prior.executionAttemptId);
      if (!operationRow || typeof operationRow.operation_id !== "string") {
        throw new Error("remote_operation_attempt_identity_mismatch");
      }
      const operations = new RemoteOperationRepository(this.database, this.clock);
      const operation = operations.getRequired(
        opaqueIdentifierSchema.parse(operationRow.operation_id)
      );
      const occupiesCapacity = reservationOccupiesHostCapacity(operation);
      if (
        operation.executionAttemptId !== prior.executionAttemptId ||
        operation.attempt.status !== "interrupted" ||
        operation.attempt.stateVersion !== input.expectedAttemptVersion ||
        operation.attempt.leaseId !== prior.leaseId
      ) {
        throw new Error("remote_resume_attempt_conflict");
      }
      const onlineAfter = new Date(now.getTime() - this.options.hostOfflineAfterMs).toISOString();
      const hostRow = this.database
        .prepare(
          `SELECT capabilities_json,capacity,
             (SELECT COUNT(*) FROM host_capacity_reservations r
               WHERE r.host_id=agent_hosts.id AND r.status='active'
                 AND ${capacityManagedReservationSql}) AS active_reservations
           FROM agent_hosts
           WHERE id=? AND revoked_at IS NULL AND last_seen_at>=?
             AND (credential_expires_at IS NULL OR credential_expires_at>?)`
        )
        .get(prior.hostId, onlineAfter, now.toISOString());
      if (!hostRow) throw new Error("remote_resume_host_unavailable");
      const capabilities = capabilitiesSchema.parse(JSON.parse(String(hostRow.capabilities_json)));
      if (!capabilities.includes("acp.session.load")) {
        throw new Error("remote_resume_session_load_unsupported");
      }
      const capacity = z.number().int().positive().parse(hostRow.capacity);
      const activeReservations = z.number().int().nonnegative().parse(hostRow.active_reservations);
      if (occupiesCapacity && activeReservations >= capacity) {
        throw new Error("remote_resume_host_capacity_exhausted");
      }
      const fencingToken = prior.fencingToken + 1;
      this.database
        .prepare(
          `INSERT INTO host_capacity_reservations(
            lease_id,execution_attempt_id,host_id,fencing_token,status,lease_expires_at,created_at
          ) VALUES (?,?,?,?,'active',?,?)`
        )
        .run(
          leaseId,
          prior.executionAttemptId,
          prior.hostId,
          fencingToken,
          leaseExpiresAt,
          now.toISOString()
        );
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_attempts
           SET status='activated',lease_id=?,lease_fencing_token=?,lease_expires_at=?,
             state_version=state_version+1,updated_at=?
           WHERE execution_attempt_id=? AND status='interrupted' AND lease_id=?
             AND state_version=?`
        )
        .run(
          leaseId,
          fencingToken,
          leaseExpiresAt,
          now.toISOString(),
          prior.executionAttemptId,
          prior.leaseId,
          input.expectedAttemptVersion
        );
      if (updated.changes !== 1) throw new Error("remote_resume_attempt_conflict");
      this.database
        .prepare("UPDATE remote_operations SET state='activated',updated_at=? WHERE id=?")
        .run(now.toISOString(), operation.id);
      operations.appendEvent(
        operation.id,
        operation.executionAttemptId,
        "remote.attempt.activated",
        now.toISOString()
      );
      return this.getRequired(leaseId);
    });
  }

  isResumeApplied(input: {
    priorLeaseId: string;
    leaseId: string;
    executionAttemptId: string;
    leaseExpiresAt: string;
  }): boolean {
    const prior = this.getRequired(input.priorLeaseId);
    const current = this.get(input.leaseId);
    if (!current) return false;
    const operationRow = this.database
      .prepare("SELECT status,lease_id FROM remote_execution_attempts WHERE execution_attempt_id=?")
      .get(input.executionAttemptId);
    return (
      prior.executionAttemptId === input.executionAttemptId &&
      current.executionAttemptId === input.executionAttemptId &&
      current.hostId === prior.hostId &&
      current.fencingToken === prior.fencingToken + 1 &&
      current.status === "active" &&
      current.leaseExpiresAt === input.leaseExpiresAt &&
      operationRow?.lease_id === current.leaseId &&
      (operationRow.status === "activated" || operationRow.status === "running")
    );
  }

  finalizeFencedAttempt(input: {
    operationId: string;
    executionAttemptId: string;
    leaseId: string;
    status: "completed" | "failed" | "cancelled";
  }): void {
    inWriteTransaction(this.database, () => {
      const reservation = this.getRequired(input.leaseId);
      if (reservation.executionAttemptId !== input.executionAttemptId) {
        throw new Error("remote_terminal_attempt_identity_mismatch");
      }
      if (reservation.status === "active") throw new Error("reservation_still_active");
      const operations = new RemoteOperationRepository(this.database, this.clock);
      const operation = operations.getRequired(input.operationId);
      if (operation.executionAttemptId !== input.executionAttemptId) {
        throw new Error("remote_terminal_attempt_identity_mismatch");
      }
      if (operation.state === input.status && operation.attempt.status === input.status) return;
      if (
        operation.attempt.status !== "interrupted" &&
        operation.attempt.status !== "action_required" &&
        operation.attempt.status !== "awaiting_writeback"
      ) {
        throw new Error("remote_terminal_persistence_conflict");
      }
      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_attempts SET status=?,state_version=state_version+1,
             updated_at=?,terminal_at=? WHERE execution_attempt_id=? AND operation_id=?
             AND lease_id=? AND status IN ('interrupted','action_required','awaiting_writeback')`
        )
        .run(input.status, now, now, input.executionAttemptId, operation.id, reservation.leaseId);
      if (updated.changes !== 1) throw new Error("remote_terminal_persistence_conflict");
      this.database
        .prepare("UPDATE remote_operations SET state=?,updated_at=?,terminal_at=? WHERE id=?")
        .run(input.status, now, now, operation.id);
      operations.appendEvent(
        operation.id,
        operation.executionAttemptId,
        attemptEventForRelease(input.status),
        now
      );
    });
  }

  transition(input: {
    leaseId: string;
    fencingToken: number;
    expectedAttemptVersion: number;
    status: z.infer<typeof activeAttemptTransitionSchema>;
  }) {
    const status = activeAttemptTransitionSchema.parse(input.status);
    return inWriteTransaction(this.database, () => {
      const reservation = this.getRequired(input.leaseId);
      if (reservation.fencingToken !== input.fencingToken) {
        throw new Error("reservation_fence_conflict");
      }
      if (reservation.status !== "active") throw new Error("reservation_not_active");
      const operations = new RemoteOperationRepository(this.database, this.clock);
      const operationIdRow = this.database
        .prepare("SELECT operation_id FROM remote_execution_attempts WHERE execution_attempt_id=?")
        .get(reservation.executionAttemptId);
      if (!operationIdRow || typeof operationIdRow.operation_id !== "string") {
        throw new Error("remote_operation_attempt_identity_mismatch");
      }
      const operation = operations.getRequired(
        opaqueIdentifierSchema.parse(operationIdRow.operation_id)
      );
      const allowed: Readonly<Record<string, readonly string[]>> = {
        reserved: ["activated"],
        activated: ["running", "interrupted"],
        running: ["interrupted", "action_required", "awaiting_writeback"],
        interrupted: ["running"],
        action_required: ["running", "interrupted"]
      };
      if (!allowed[operation.attempt.status]?.includes(status)) {
        throw new Error("remote_attempt_transition_invalid");
      }
      if (operation.attempt.stateVersion !== input.expectedAttemptVersion) {
        throw new Error("remote_attempt_version_conflict");
      }
      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_attempts SET status=?,state_version=state_version+1,updated_at=?
           WHERE execution_attempt_id=? AND lease_id=? AND lease_fencing_token=?
             AND state_version=?`
        )
        .run(
          status,
          now,
          operation.executionAttemptId,
          reservation.leaseId,
          reservation.fencingToken,
          input.expectedAttemptVersion
        );
      if (updated.changes !== 1) throw new Error("remote_attempt_version_conflict");
      this.database
        .prepare("UPDATE remote_operations SET state=?,updated_at=? WHERE id=?")
        .run(status, now, operation.id);
      const eventType =
        status === "action_required"
          ? "remote.attempt.action_required"
          : status === "awaiting_writeback"
            ? "remote.attempt.awaiting_writeback"
            : status === "activated"
              ? "remote.attempt.activated"
              : status === "running"
                ? "remote.attempt.running"
                : "remote.attempt.interrupted";
      operations.appendEvent(operation.id, operation.executionAttemptId, eventType, now);
      return operations.getRequired(operation.id);
    });
  }

  release(input: {
    leaseId: string;
    fencingToken: number;
    expectedVersion: number;
    reason: z.infer<typeof reservationReleaseReasonSchema>;
  }): HostCapacityReservation {
    const reason = reservationReleaseReasonSchema.parse(input.reason);
    return inWriteTransaction(this.database, () => {
      const reservation = this.getRequired(input.leaseId);
      if (reservation.fencingToken !== input.fencingToken) {
        throw new Error("reservation_fence_conflict");
      }
      if (reservation.version !== input.expectedVersion) {
        throw new Error("reservation_version_conflict");
      }
      if (reservation.status !== "active") throw new Error("reservation_not_active");
      const operationIdRow = this.database
        .prepare("SELECT operation_id FROM remote_execution_attempts WHERE execution_attempt_id=?")
        .get(reservation.executionAttemptId);
      if (!operationIdRow || typeof operationIdRow.operation_id !== "string") {
        throw new Error("remote_operation_attempt_identity_mismatch");
      }
      const operationId = opaqueIdentifierSchema.parse(operationIdRow.operation_id);
      const now = this.clock().toISOString();
      const reservationStatus =
        reason === "expired" ? "expired" : reason === "cancelled" ? "cancelled" : "released";
      const attemptStatus = reason === "expired" ? "interrupted" : reason;
      const terminalAt = reason === "expired" ? null : now;
      const updated = this.database
        .prepare(
          `UPDATE host_capacity_reservations
           SET status=?,version=version+1,released_at=?
           WHERE lease_id=? AND status='active' AND fencing_token=? AND version=?`
        )
        .run(
          reservationStatus,
          now,
          reservation.leaseId,
          reservation.fencingToken,
          reservation.version
        );
      if (updated.changes !== 1) throw new Error("reservation_version_conflict");
      const attemptRow = this.database
        .prepare(
          `SELECT status FROM remote_execution_attempts
           WHERE execution_attempt_id=? AND lease_id=? AND lease_fencing_token=?`
        )
        .get(reservation.executionAttemptId, reservation.leaseId, reservation.fencingToken) as
        | { status?: unknown }
        | undefined;
      const dispatchRow = this.database
        .prepare(
          `SELECT status FROM dispatches
           WHERE execution_attempt_id=? AND lease_id=?`
        )
        .get(reservation.executionAttemptId, reservation.leaseId) as
        | { status?: unknown }
        | undefined;
      // Host already parked a durable terminal payload on the dispatch. Expiring capacity
      // must keep writeback alive (do not demote to interrupted) even if the attempt row
      // has not yet been transitioned to awaiting_writeback.
      const preserveAwaitingWriteback =
        reason === "expired" &&
        (attemptRow?.status === "awaiting_writeback" ||
          dispatchRow?.status === "awaiting_writeback");
      if (preserveAwaitingWriteback) {
        this.database
          .prepare(
            `UPDATE remote_execution_attempts
             SET status='awaiting_writeback',state_version=state_version+1,updated_at=?,terminal_at=NULL
             WHERE execution_attempt_id=? AND lease_id=? AND lease_fencing_token=?
               AND status IN (
                 'running','activated','awaiting_writeback','action_required','interrupted'
               )`
          )
          .run(now, reservation.executionAttemptId, reservation.leaseId, reservation.fencingToken);
        this.database
          .prepare(
            `UPDATE remote_operations SET state='awaiting_writeback',updated_at=?,terminal_at=NULL
             WHERE execution_attempt_id=? AND state NOT IN ('completed','failed','cancelled')`
          )
          .run(now, reservation.executionAttemptId);
        const eventRepository = new RemoteOperationRepository(this.database, this.clock);
        const operation = eventRepository.getRequired(operationId);
        if (attemptRow?.status !== "awaiting_writeback") {
          eventRepository.appendEvent(
            operation.id,
            operation.executionAttemptId,
            "remote.attempt.awaiting_writeback",
            now
          );
        }
        eventRepository.appendEvent(
          operation.id,
          operation.executionAttemptId,
          reservationEventForRelease(reason),
          now
        );
        return this.getRequired(reservation.leaseId);
      }
      this.database
        .prepare(
          `UPDATE remote_execution_attempts
           SET status=?,state_version=state_version+1,updated_at=?,terminal_at=?
           WHERE execution_attempt_id=? AND lease_id=? AND lease_fencing_token=?`
        )
        .run(
          attemptStatus,
          now,
          terminalAt,
          reservation.executionAttemptId,
          reservation.leaseId,
          reservation.fencingToken
        );
      this.database
        .prepare(
          `UPDATE remote_operations SET state=?,updated_at=?,terminal_at=?
           WHERE execution_attempt_id=?`
        )
        .run(attemptStatus, now, terminalAt, reservation.executionAttemptId);
      const eventRepository = new RemoteOperationRepository(this.database, this.clock);
      const operation = eventRepository.getRequired(operationId);
      eventRepository.appendEvent(
        operation.id,
        operation.executionAttemptId,
        attemptEventForRelease(reason),
        now
      );
      eventRepository.appendEvent(
        operation.id,
        operation.executionAttemptId,
        reservationEventForRelease(reason),
        now
      );
      return this.getRequired(reservation.leaseId);
    });
  }
}
