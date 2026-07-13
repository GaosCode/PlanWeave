/**
 * A6 application services — Coordinator Agent lifecycle.
 *
 * Every state-changing command goes through `executeIdempotent`.
 * `startRun` is async so it can await the provider between read and write phases.
 *
 * Key invariants:
 *  - The Agent identity CANNOT approve proposals.
 *  - Every artifact citation must reference a valid source (message or attachment).
 *  - Invalid source references are rejected at write time.
 *  - Checkpoints make cancellation + restart recoverable.
 */

import { executeIdempotent, executeInUnitOfWork, type IdempotentCommand, type UnitOfWork } from "../store.js"
import { forbidden } from "../identity/errors.js"
import {
  AgentError,
  type AgentBudget,
  type AgentProvider,
  type AgentProviderContext,
  type AgentProviderOutput,
  type AgentRepository,
  type AgentServices,
  type ArtifactCitation,
  type CancelAgentRunCommand,
  type CancelRunResult,
  type StartAgentRunCommand,
  type StartRunResult,
  type StructuredArtifact
} from "./types.js"

/* ------------------------------------------------------------------ *
 * Validation helpers                                                  *
 * ------------------------------------------------------------------ */

function assertIdempotencyKey(key: string): void {
  if (!/^[\x21-\x7E]{16,128}$/.test(key)) {
    throw new AgentError("validation_failed", "Idempotency-Key must be 16..128 ASCII printable characters.", {})
  }
}

export function assertAgentCannotApprove(): never {
  throw new AgentError("state_conflict", "The Agent identity cannot approve proposals.", {})
}

function validateBudget(budget: AgentBudget): void {
  if (!Number.isInteger(budget.maxTokens) || budget.maxTokens < 1) {
    throw new AgentError("validation_failed", "budget.maxTokens must be a positive integer.", {})
  }
  if (!Number.isInteger(budget.maxDurationMs) || budget.maxDurationMs < 1) {
    throw new AgentError("validation_failed", "budget.maxDurationMs must be a positive integer.", {})
  }
  if (!Number.isInteger(budget.maxRetries) || budget.maxRetries < 0) {
    throw new AgentError("validation_failed", "budget.maxRetries must be a non-negative integer.", {})
  }
}

/**
 * Validate every citation in the output references a real source entity.
 */
export function validateCitations(
  unit: UnitOfWork,
  roomId: string,
  citations: ArtifactCitation[]
): void {
  const invalid: ArtifactCitation[] = []
  for (const citation of citations) {
    if (citation.kind === "message") {
      const row = unit.database
        .prepare("SELECT id FROM messages WHERE id=? AND room_id=?")
        .get(citation.id, roomId)
      if (!row) invalid.push(citation)
    } else if (citation.kind === "attachment") {
      const row = unit.database
        .prepare("SELECT id FROM attachments WHERE id=? AND project_id IN (SELECT project_id FROM rooms WHERE id=?)")
        .get(citation.id, roomId)
      if (!row) invalid.push(citation)
    }
  }
  if (invalid.length > 0) {
    throw new AgentError("citation_invalid", "Artifact contains invalid or foreign source citations.", {
      invalidCitations: invalid
    })
  }
}

/* ------------------------------------------------------------------ *
 * Read helpers (sync, use the shared database — no transaction)       *
 * ------------------------------------------------------------------ */

function readMessagesAfter(
  database: { prepare(sql: string): { all(...values: unknown[]): Array<Record<string, unknown>>; get(...values: unknown[]): Record<string, unknown> | undefined } },
  roomId: string,
  cursorId: string | null
): Array<Record<string, unknown>> {
  if (!cursorId) {
    return database.prepare("SELECT id, body, kind, author_user_id, created_at FROM messages WHERE room_id=? ORDER BY created_at, id ASC").all(roomId)
  }
  const cursorRow = database.prepare("SELECT created_at FROM messages WHERE id=? AND room_id=?").get(cursorId, roomId) as { created_at: string } | undefined
  if (!cursorRow) {
    return database.prepare("SELECT id, body, kind, author_user_id, created_at FROM messages WHERE room_id=? ORDER BY created_at, id ASC").all(roomId)
  }
  return database.prepare(
    "SELECT id, body, kind, author_user_id, created_at FROM messages WHERE room_id=? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id ASC"
  ).all(roomId, cursorRow.created_at, cursorRow.created_at, cursorId)
}

function readAttachmentsAfter(
  database: { prepare(sql: string): { all(...values: unknown[]): Array<Record<string, unknown>>; get(...values: unknown[]): Record<string, unknown> | undefined } },
  projectId: string,
  cursorId: string | null
): Array<Record<string, unknown>> {
  if (!cursorId) {
    return database.prepare("SELECT id, original_name, media_type, created_at FROM attachments WHERE project_id=? ORDER BY created_at, id ASC").all(projectId)
  }
  const cursorRow = database.prepare("SELECT created_at FROM attachments WHERE id=? AND project_id=?").get(cursorId, projectId) as { created_at: string } | undefined
  if (!cursorRow) {
    return database.prepare("SELECT id, original_name, media_type, created_at FROM attachments WHERE project_id=? ORDER BY created_at, id ASC").all(projectId)
  }
  return database.prepare(
    "SELECT id, original_name, media_type, created_at FROM attachments WHERE project_id=? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id ASC"
  ).all(projectId, cursorRow.created_at, cursorRow.created_at, cursorId)
}

function rowToArtifact(row: Record<string, unknown>): StructuredArtifact {
  let citations: ArtifactCitation[] = []
  try { citations = JSON.parse(String(row.citations_json)) } catch { /* keep empty */ }
  return {
    id: String(row.id),
    runId: String(row.run_id),
    checkpointId: String(row.checkpoint_id),
    kind: String(row.kind) as StructuredArtifact["kind"],
    title: String(row.title),
    body: String(row.body),
    citations,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

/* ------------------------------------------------------------------ *
 * Service factory                                                     *
 * ------------------------------------------------------------------ */

type CreateAgentServicesOptions = {
  repository: AgentRepository
  provider: AgentProvider
  now?: () => string
}

class AgentRunCancelled extends Error {
  constructor() { super("Agent run was cancelled.") }
}

class AgentRunTimedOut extends Error {
  constructor() { super("Agent run exceeded its maximum duration.") }
}

export function createAgentServices(options: CreateAgentServicesOptions): AgentServices {
  const { repository, provider } = options
  const clock = options.now ?? (() => new Date().toISOString())
  const db = repository.database
  const inFlightByRequest = new Map<string, Promise<StartRunResult>>()
  const controllersByRun = new Map<string, AbortController>()

  const startRun: AgentServices["startRun"] = async (command) => {
    assertIdempotencyKey(command.idempotencyKey)
    if (!command.roomId || typeof command.roomId !== "string") {
      throw new AgentError("validation_failed", "roomId is required.", {})
    }
    if (!command.providerType || typeof command.providerType !== "string") {
      throw new AgentError("validation_failed", "providerType is required.", {})
    }
    validateBudget(command.budget)

    // --- Phase 1: read-side validation (sync, no txn) ---
    const room = db.prepare("SELECT id, project_id FROM rooms WHERE id=?").get(command.roomId)
    if (!room) {
      throw new AgentError("not_found", `Room '${command.roomId}' does not exist.`, { aggregateId: command.roomId })
    }
    if (String(room.project_id) !== command.projectId) {
      throw new AgentError("validation_failed", "Room does not belong to the given project.", {})
    }
    const membership = db.prepare("SELECT role FROM memberships WHERE project_id=? AND user_id=?").get(command.projectId, command.actorId)
    if (!membership) {
      throw forbidden("User is not a member of the project.", { projectId: command.projectId, userId: command.actorId })
    }

    const route = `/api/v1/projects/${command.projectId}/agent-runs`
    const fingerprint = `${command.providerType}:${command.roomId}:${JSON.stringify(command.budget)}`
    const requestKey = `${command.deviceId}\u0000${command.projectId}\u0000${command.idempotencyKey}`
    type Reservation =
      | { kind: "completed"; value: StartRunResult }
      | { kind: "running"; runId: string; replayed: boolean }
    const reservation = executeInUnitOfWork(db, (unit): Reservation => {
      const prior = unit.database.prepare(
        "SELECT request_fingerprint,status_code,response_json FROM idempotency_keys WHERE device_id=? AND route=? AND project_id IS ? AND key=?"
      ).get(command.deviceId, route, command.projectId, command.idempotencyKey)
      if (prior) {
        if (String(prior.request_fingerprint) !== fingerprint) {
          throw new AgentError("idempotency_key_reused", "Idempotency key was reused with a different request.", {})
        }
        const statusCode = Number(prior.status_code)
        const persisted = JSON.parse(String(prior.response_json)) as Record<string, unknown>
        if (statusCode === 200) return { kind: "completed", value: persisted as unknown as StartRunResult }
        if (statusCode >= 400) {
          const error = persisted.error as { code?: AgentError["code"]; message?: string; details?: AgentError["details"] } | undefined
          throw new AgentError(error?.code ?? "provider_failure", error?.message ?? "Agent run failed.", error?.details ?? {})
        }
        const runId = String(persisted.runId ?? "")
        const existingRun = repository.loadRun(runId)
        if (!existingRun) throw new AgentError("not_found", "Reserved agent run no longer exists.", { aggregateId: runId })
        return { kind: "running", runId, replayed: true }
      }

      const now = clock()
      const runId = `agrun_${cryptoRandomId()}`
      const run = repository.insertRun(unit, {
        id: runId,
        projectId: command.projectId,
        roomId: command.roomId,
        status: "running",
        providerType: command.providerType,
        now
      })
      unit.database.prepare(
        "INSERT INTO idempotency_keys(device_id,route,project_id,key,request_fingerprint,status_code,response_json,created_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(command.deviceId, route, command.projectId, command.idempotencyKey, fingerprint, 102, JSON.stringify({ runId }), now)
      unit.appendEvent({
        projectId: command.projectId,
        aggregateType: "agent_run",
        aggregateId: run.id,
        aggregateVersion: run.version,
        type: "agent.run_started"
      })
      unit.audit({
        projectId: command.projectId,
        actorId: command.actorId,
        action: "agent.run_started",
        aggregateType: "agent_run",
        aggregateId: run.id,
        details: { roomId: command.roomId, providerType: command.providerType }
      })
      return { kind: "running", runId, replayed: false }
    })
    if (reservation.kind === "completed") return { replayed: true, value: reservation.value }

    const existingExecution = inFlightByRequest.get(requestKey)
    if (existingExecution) return { replayed: true, value: await existingExecution }

    const priorCheckpoint = db.prepare(
      "SELECT c.* FROM agent_checkpoints c JOIN agent_runs r ON r.id=c.run_id WHERE r.room_id=? AND r.id<>? ORDER BY c.rowid DESC LIMIT 1"
    ).get(command.roomId, reservation.runId)
    const priorMessageCursor = priorCheckpoint?.message_cursor ? String(priorCheckpoint.message_cursor) : null
    const priorAttachmentCursor = priorCheckpoint?.attachment_cursor ? String(priorCheckpoint.attachment_cursor) : null
    const priorArtifacts = priorCheckpoint
      ? db.prepare("SELECT * FROM agent_artifacts WHERE checkpoint_id=? ORDER BY created_at ASC").all(String(priorCheckpoint.id)).map(rowToArtifact)
      : []
    const newMessages = readMessagesAfter(db, command.roomId, priorMessageCursor)
    const newAttachments = readAttachmentsAfter(db, command.projectId, priorAttachmentCursor)
    const contextMessages = newMessages.map((m) => ({
      id: String(m.id),
      body: String(m.body),
      kind: String(m.kind),
      authorUserId: String(m.author_user_id),
      createdAt: String(m.created_at)
    }))
    const contextAttachments = newAttachments.map((a) => ({
      id: String(a.id),
      originalName: String(a.original_name),
      mediaType: String(a.media_type),
      createdAt: String(a.created_at)
    }))

    const context: AgentProviderContext = {
      room: { id: command.roomId, projectId: command.projectId },
      messages: contextMessages,
      attachments: contextAttachments,
      existingArtifacts: priorArtifacts,
      budget: command.budget
    }

    const controller = new AbortController()
    controllersByRun.set(reservation.runId, controller)

    const executeProvider = async (): Promise<AgentProviderOutput> => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const aborted = new Promise<never>((_, reject) => {
        const rejectForAbort = () => reject(controller.signal.reason ?? new AgentRunCancelled())
        if (controller.signal.aborted) rejectForAbort()
        else controller.signal.addEventListener("abort", rejectForAbort, { once: true })
      })
      timeout = setTimeout(() => controller.abort(new AgentRunTimedOut()), command.budget.maxDurationMs)
      timeout.unref()
      try {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await Promise.race([provider.run(context, controller.signal), aborted])
          } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason ?? error
            if (attempt >= command.budget.maxRetries) throw error
          }
        }
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }

    const execution = (async (): Promise<StartRunResult> => {
      try {
        const providerOutput = await executeProvider()
        return executeInUnitOfWork(db, (unit) => {
          const run = repository.loadRun(reservation.runId)
          if (!run) throw new AgentError("not_found", "Agent run no longer exists.", { aggregateId: reservation.runId })
          if (run.status === "cancelled") throw new AgentError("run_cancelled", "Agent run was cancelled.", { aggregateId: run.id })
          if (run.status !== "running") throw new AgentError("state_conflict", "Agent run is no longer active.", { aggregateId: run.id })
          for (const artifact of providerOutput.artifacts) validateCitations(unit, command.roomId, artifact.citations)

          const now = clock()
          const latest = repository.loadLatestCheckpoint(unit, run.id)
          const checkpoint = repository.insertCheckpoint(unit, {
            id: `agcp_${cryptoRandomId()}`,
            runId: run.id,
            sequence: (latest?.sequence ?? 0) + 1,
            messageCursor: contextMessages.at(-1)?.id ?? priorMessageCursor,
            attachmentCursor: contextAttachments.at(-1)?.id ?? priorAttachmentCursor,
            artifactsJson: JSON.stringify(providerOutput.artifacts),
            now
          })
          const artifacts: StructuredArtifact[] = []
          for (const artifact of providerOutput.artifacts) {
            artifacts.push(repository.insertArtifact(unit, {
              id: `agart_${cryptoRandomId()}`,
              runId: run.id,
              checkpointId: checkpoint.id,
              kind: artifact.kind,
              title: artifact.title,
              body: artifact.body,
              citationsJson: JSON.stringify(artifact.citations),
              now
            }))
          }
          const finalStatus = providerOutput.done ? "completed" as const : "running" as const
          const updatedRun = repository.updateRun(unit, run, { status: finalStatus }, now)
          const value = { run: updatedRun, checkpoint, artifacts }
          unit.database.prepare(
            "UPDATE idempotency_keys SET status_code=200,response_json=? WHERE device_id=? AND route=? AND project_id IS ? AND key=? AND status_code=102"
          ).run(JSON.stringify(value), command.deviceId, route, command.projectId, command.idempotencyKey)
          unit.appendEvent({
            projectId: command.projectId,
            aggregateType: "agent_run",
            aggregateId: run.id,
            aggregateVersion: updatedRun.version,
            type: finalStatus === "completed" ? "agent.run_completed" : "agent.run_checkpointed"
          })
          return value
        })
      } catch (error) {
        const agentError = error instanceof AgentError
          ? error
          : error instanceof AgentRunCancelled || (error instanceof Error && error.message === "Run cancelled")
            ? new AgentError("run_cancelled", "Agent run was cancelled.", { aggregateId: reservation.runId })
            : error instanceof AgentRunTimedOut
              ? new AgentError("run_timeout", "Agent run exceeded its maximum duration.", { aggregateId: reservation.runId })
              : new AgentError("provider_failure", "Agent provider failed.", { aggregateId: reservation.runId })
        executeInUnitOfWork(db, (unit) => {
          const current = repository.loadRun(reservation.runId)
          if (current?.status === "running") {
            const failed = repository.updateRun(unit, current, { status: "failed" }, clock())
            unit.appendEvent({
              projectId: current.projectId,
              aggregateType: "agent_run",
              aggregateId: current.id,
              aggregateVersion: failed.version,
              type: "agent.run_failed"
            })
          }
          unit.database.prepare(
            "UPDATE idempotency_keys SET status_code=?,response_json=? WHERE device_id=? AND route=? AND project_id IS ? AND key=? AND status_code=102"
          ).run(agentError.code === "run_cancelled" ? 499 : 500, JSON.stringify({ error: { code: agentError.code, message: agentError.message, details: agentError.details } }), command.deviceId, route, command.projectId, command.idempotencyKey)
        })
        throw agentError
      } finally {
        controllersByRun.delete(reservation.runId)
        inFlightByRequest.delete(requestKey)
      }
    })()
    inFlightByRequest.set(requestKey, execution)
    return { replayed: reservation.replayed, value: await execution }
  }

  const cancelRun: AgentServices["cancelRun"] = (command) => {
    assertIdempotencyKey(command.idempotencyKey)
    const fingerprint = `cancel:${command.runId}:${command.actorId}`
    const idempotent: IdempotentCommand<CancelRunResult> = {
      deviceId: command.deviceId,
      route: `/api/v1/agent-runs/${command.runId}/cancel`,
      projectId: undefined,
      key: command.idempotencyKey,
      requestFingerprint: fingerprint,
      execute: (unit) => {
        const run = repository.loadRun(command.runId)
        if (!run) {
          throw new AgentError("not_found", `Agent run '${command.runId}' does not exist.`, { aggregateId: command.runId })
        }
        const membership = unit.database.prepare("SELECT role FROM memberships WHERE project_id=? AND user_id=?").get(run.projectId, command.actorId)
        if (!membership) {
          throw new AgentError("forbidden", "Only a project member may cancel this agent run.", {
            aggregateType: "agent_run",
            aggregateId: command.runId
          })
        }
        if (run.status === "cancelled") {
          return { run }
        }
        if (run.status !== "running") {
          throw new AgentError("state_conflict", "Only running agent runs can be cancelled.", {
            aggregateType: "agent_run",
            aggregateId: command.runId
          })
        }
        const now = clock()
        const updated = repository.updateRun(unit, run, { status: "cancelled", cancelledAt: now }, now)
        unit.appendEvent({
          projectId: run.projectId,
          aggregateType: "agent_run",
          aggregateId: run.id,
          aggregateVersion: updated.version,
          type: "agent.run_cancelled"
        })
        unit.audit({
          projectId: run.projectId,
          actorId: command.actorId,
          action: "agent.run_cancelled",
          aggregateType: "agent_run",
          aggregateId: run.id,
          details: {}
        })
        return { run: updated }
      }
    }
    const result = executeIdempotent(repository.database, idempotent)
    controllersByRun.get(command.runId)?.abort(new AgentRunCancelled())
    return { replayed: result.replayed, value: result.value }
  }

  const getRun: AgentServices["getRun"] = (runId) => {
    return repository.loadRun(runId)
  }

  const getArtifactsForRun: AgentServices["getArtifactsForRun"] = (runId) => {
    return (db.prepare("SELECT * FROM agent_artifacts WHERE run_id=? ORDER BY created_at ASC").all(runId) as Array<Record<string, unknown>>)
      .map(rowToArtifact)
  }

  return {
    repository,
    startRun,
    cancelRun,
    getRun,
    getArtifactsForRun
  }
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(9)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
