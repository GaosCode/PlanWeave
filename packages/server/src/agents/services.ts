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

import { executeIdempotent, type IdempotentCommand, type UnitOfWork } from "../store.js"
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

function buildCursor(entities: Array<{ kind: "message" | "attachment"; id: string }>): string | null {
  if (entities.length === 0) return null
  const last = entities[entities.length - 1]
  return `${last.kind}:${last.id}`
}

/* ------------------------------------------------------------------ *
 * Read helpers (sync, use the shared database — no transaction)       *
 * ------------------------------------------------------------------ */

function readMessagesAfter(
  database: { prepare(sql: string): { all(...values: unknown[]): Array<Record<string, unknown>>; get(...values: unknown[]): Record<string, unknown> | undefined } },
  roomId: string,
  consumedCursor: string | null
): Array<Record<string, unknown>> {
  if (!consumedCursor) {
    return database.prepare("SELECT id, body, kind, author_user_id, created_at FROM messages WHERE room_id=? ORDER BY created_at, id ASC").all(roomId)
  }
  const [cursorKind, cursorId] = consumedCursor.split(":")
  if (cursorKind !== "message") {
    return database.prepare("SELECT id, body, kind, author_user_id, created_at FROM messages WHERE room_id=? ORDER BY created_at, id ASC").all(roomId)
  }
  const cursorRow = database.prepare("SELECT created_at FROM messages WHERE id=?").get(cursorId) as { created_at: string } | undefined
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
  consumedCursor: string | null
): Array<Record<string, unknown>> {
  if (!consumedCursor) {
    return database.prepare("SELECT id, original_name, media_type, created_at FROM attachments WHERE project_id=? ORDER BY created_at, id ASC").all(projectId)
  }
  const [cursorKind, cursorId] = consumedCursor.split(":")
  if (cursorKind !== "attachment") {
    return database.prepare("SELECT id, original_name, media_type, created_at FROM attachments WHERE project_id=? ORDER BY created_at, id ASC").all(projectId)
  }
  const cursorRow = database.prepare("SELECT created_at FROM attachments WHERE id=?").get(cursorId) as { created_at: string } | undefined
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

export function createAgentServices(options: CreateAgentServicesOptions): AgentServices {
  const { repository, provider } = options
  const clock = options.now ?? (() => new Date().toISOString())
  const db = repository.database

  /**
   * Phase 1-2: pre-validation + read context (sync, no write txn).
   * Phase 3: await provider.run(context) (async, no txn).
   * Phase 4: executeIdempotent to persist (sync write txn).
   */
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

    // --- Phase 2: read context (sync, no txn) ---
    const priorRun = repository.loadLatestRunForRoom(command.roomId)
    let consumedCursor: string | null = null
    let priorArtifacts: StructuredArtifact[] = []
    let priorSequence = 0
    if (priorRun) {
      const chkRow = db.prepare("SELECT * FROM agent_checkpoints WHERE run_id=? ORDER BY sequence DESC LIMIT 1").get(priorRun.id)
      if (chkRow) {
        consumedCursor = String(chkRow.consumed_cursor ?? "")
        if (!consumedCursor) consumedCursor = null
        priorSequence = Number(chkRow.sequence)
        const artRows = db.prepare("SELECT * FROM agent_artifacts WHERE checkpoint_id=? ORDER BY created_at ASC").all(String(chkRow.id))
        priorArtifacts = artRows.map(rowToArtifact)
      }
    }

    const newMessages = readMessagesAfter(db, command.roomId, consumedCursor)
    const newAttachments = readAttachmentsAfter(db, command.projectId, consumedCursor)

    // --- Phase 3: call provider (async, no txn) ---
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

    let providerOutput: AgentProviderOutput
    try {
      providerOutput = await provider.run(context)
    } catch (error) {
      if (error instanceof Error && error.message === "Run cancelled") {
        throw new AgentError("run_cancelled", "Agent run was cancelled.", {})
      }
      throw new AgentError("provider_failure", "Agent provider failed.", {})
    }

    // --- Phase 4: write transaction via executeIdempotent ---
    const fingerprint = `${command.providerType}:${command.roomId}:${JSON.stringify(command.budget)}`
    const idempotent: IdempotentCommand<StartRunResult> = {
      deviceId: command.deviceId,
      route: `/api/v1/projects/${command.projectId}/agent-runs`,
      projectId: command.projectId,
      key: command.idempotencyKey,
      requestFingerprint: fingerprint,
      execute: (unit) => {
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

        // Validate citations for every artifact inside the write txn
        for (const artifact of providerOutput.artifacts) {
          validateCitations(unit, command.roomId, artifact.citations)
        }

        const allNewEntities = [
          ...contextMessages.map((m) => ({ kind: "message" as const, id: m.id })),
          ...contextAttachments.map((a) => ({ kind: "attachment" as const, id: a.id }))
        ]
        const nextCursor = buildCursor(allNewEntities)

        const checkpointSequence = priorSequence + 1
        const checkpointId = `agcp_${cryptoRandomId()}`
        const checkpoint = repository.insertCheckpoint(unit, {
          id: checkpointId,
          runId,
          sequence: checkpointSequence,
          consumedCursor: nextCursor,
          artifactsJson: JSON.stringify(providerOutput.artifacts),
          now
        })

        const artifacts: StructuredArtifact[] = []
        for (const artifact of providerOutput.artifacts) {
          const artId = `agart_${cryptoRandomId()}`
          const created = repository.insertArtifact(unit, {
            id: artId,
            runId,
            checkpointId: checkpoint.id,
            kind: artifact.kind,
            title: artifact.title,
            body: artifact.body,
            citationsJson: JSON.stringify(artifact.citations),
            now
          })
          artifacts.push(created)
        }

        const finalStatus = providerOutput.done ? "completed" as const : "running" as const
        const updatedRun = repository.updateRun(unit, run, { status: finalStatus }, now)

        unit.appendEvent({
          projectId: command.projectId,
          aggregateType: "agent_run",
          aggregateId: runId,
          aggregateVersion: updatedRun.version,
          type: finalStatus === "completed" ? "agent.run_completed" : "agent.run_checkpointed"
        })
        unit.audit({
          projectId: command.projectId,
          actorId: command.actorId,
          action: "agent.run_started",
          aggregateType: "agent_run",
          aggregateId: runId,
          details: { roomId: command.roomId, providerType: command.providerType, checkpointSequence }
        })

        return { run: updatedRun, checkpoint, artifacts }
      }
    }
    return executeIdempotent(repository.database, idempotent)
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
