/**
 * Domain types for A6 — Coordinator Agent and consensus artifacts.
 *
 * The Coordinator Agent is an identity within the server that consumes the
 * project's planning room (messages + attachments) and produces structured
 * consensus artifacts. The Agent cannot approve proposals — that remains a
 * human-only server command.
 *
 * Every artifact claim must reference valid source IDs (message or
 * attachment). Invalid source references are rejected at write time.
 *
 * Provider-neutral contracts allow the agent to be backed by a real
 * LLM provider or a deterministic fake for tests.
 */

import type { DomainEvent, UnitOfWork } from "../store.js"
import type { SqliteDatabase } from "../sqlite.js"

/* ------------------------------------------------------------------ *
 * Agent run lifecycle                                                 *
 * ------------------------------------------------------------------ */

export const agentRunStatuses = ["running", "completed", "cancelled", "failed"] as const
export type AgentRunStatus = (typeof agentRunStatuses)[number]

export type AgentRun = {
  id: string
  projectId: string
  /** The room whose messages are being analysed. */
  roomId: string
  status: AgentRunStatus
  /** Identifies the provider that produced this run (e.g. "fake", "openai"). */
  providerType: string
  version: number
  createdAt: string
  updatedAt: string
  cancelledAt: string | null
}

/* ------------------------------------------------------------------ *
 * Checkpoints — incremental snapshots so cancellation / restart      *
 * leaves a recoverable run state.                                     *
 * ------------------------------------------------------------------ */

export type AgentCheckpoint = {
  id: string
  runId: string
  /** Monotonically-increasing checkpoint sequence for this run. */
  sequence: number
  /**
   * The latest message.id or attachment.id that was consumed into the
   * checkpoint. Future invocations resume from this cursor.
   */
  consumedCursor: string | null
  /** Independent stream cursors prevent one entity kind replaying the other. */
  messageCursor: string | null
  attachmentCursor: string | null
  /** Serialised structured-artifact set at this checkpoint. */
  artifactsJson: string
  createdAt: string
}

/* ------------------------------------------------------------------ *
 * Structured artifacts produced by the Coordinator Agent              *
 * ------------------------------------------------------------------ */

export const artifactKinds = [
  "brief",
  "requirements",
  "constraints",
  "adr_candidate",
  "open_question",
  "risk",
  "task_allocation"
] as const
export type ArtifactKind = (typeof artifactKinds)[number]

/**
 * Every artifact claim MUST reference valid source IDs.
 * `kind` mirrors the Citation from proposals: "message" | "attachment".
 */
export type ArtifactCitation = {
  kind: "message" | "attachment"
  id: string
}

export type StructuredArtifact = {
  id: string
  runId: string
  checkpointId: string
  kind: ArtifactKind
  title: string
  body: string
  /** Ordered list of source citations. */
  citations: ArtifactCitation[]
  version: number
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------ *
 * Provider-neutral contracts                                          *
 * ------------------------------------------------------------------ */

export type AgentBudget = {
  /** Maximum number of tokens the provider may consume. */
  maxTokens: number
  /** Maximum wall-clock milliseconds for the entire run. */
  maxDurationMs: number
  /** Maximum retry attempts on transient failure. */
  maxRetries: number
}

export type AgentProviderContext = {
  room: { id: string; projectId: string }
  /** Messages added since the last checkpoint cursor. */
  messages: Array<{ id: string; body: string; kind: string; authorUserId: string; createdAt: string }>
  /** Attachments added since the last checkpoint cursor. */
  attachments: Array<{ id: string; originalName: string; mediaType: string; createdAt: string }>
  /** The current set of structured artifacts (carried forward). */
  existingArtifacts: StructuredArtifact[]
  budget: AgentBudget
}

/**
 * The output a provider must return after consuming the context.
 * The services layer validates citations before persisting.
 */
export type AgentProviderOutput = {
  artifacts: Array<{
    kind: ArtifactKind
    title: string
    body: string
    citations: ArtifactCitation[]
  }>
  /** If true the run is complete; otherwise the provider wants another cycle. */
  done: boolean
}

export type AgentProvider = {
  readonly type: string
  run(context: AgentProviderContext, signal?: AbortSignal): Promise<AgentProviderOutput>
}

/* ------------------------------------------------------------------ *
 * Commands                                                            *
 * ------------------------------------------------------------------ */

export type StartAgentRunCommand = {
  deviceId: string
  idempotencyKey: string
  projectId: string
  roomId: string
  providerType: string
  budget: AgentBudget
  actorId: string
}

export type CancelAgentRunCommand = {
  deviceId: string
  idempotencyKey: string
  runId: string
  actorId: string
}

/* ------------------------------------------------------------------ *
 * Error envelope                                                      *
 * ------------------------------------------------------------------ */

export type AgentErrorCode =
  | "validation_failed"
  | "version_conflict"
  | "state_conflict"
  | "forbidden"
  | "idempotency_key_reused"
  | "not_found"
  | "citation_invalid"
  | "provider_failure"
  | "run_timeout"
  | "run_cancelled"

export type AgentErrorDetails = {
  aggregateType?: string
  aggregateId?: string
  currentVersion?: number
  expectedVersion?: number
  /** When citation validation fails, list the bad references. */
  invalidCitations?: ArtifactCitation[]
}

export class AgentError extends Error {
  readonly code: AgentErrorCode
  readonly details: AgentErrorDetails
  constructor(code: AgentErrorCode, message: string, details: AgentErrorDetails = {}) {
    super(message)
    this.name = "AgentError"
    this.code = code
    this.details = details
  }
}

/* ------------------------------------------------------------------ *
 * Repository contract                                                 *
 * ------------------------------------------------------------------ */

export type AgentRepository = {
  database: SqliteDatabase
  loadRun(runId: string): AgentRun | null
  insertRun(unit: UnitOfWork, input: {
    id: string
    projectId: string
    roomId: string
    status: AgentRunStatus
    providerType: string
    now: string
  }): AgentRun
  updateRun(unit: UnitOfWork, current: AgentRun, patch: Partial<Pick<AgentRun, "status" | "cancelledAt">>, now: string): AgentRun
  loadLatestCheckpoint(unit: UnitOfWork, runId: string): AgentCheckpoint | null
  insertCheckpoint(unit: UnitOfWork, input: {
    id: string
    runId: string
    sequence: number
    messageCursor: string | null
    attachmentCursor: string | null
    artifactsJson: string
    now: string
  }): AgentCheckpoint
  insertArtifact(unit: UnitOfWork, input: {
    id: string
    runId: string
    checkpointId: string
    kind: ArtifactKind
    title: string
    body: string
    citationsJson: string
    now: string
  }): StructuredArtifact
  loadArtifactsForRun(unit: UnitOfWork, runId: string): StructuredArtifact[]
  loadArtifactsForCheckpoint(unit: UnitOfWork, checkpointId: string): StructuredArtifact[]
  /** Load the previous non-cancelled run for this room (for restart recovery). */
  loadLatestRunForRoom(roomId: string): AgentRun | null
}

/* ------------------------------------------------------------------ *
 * Services contract                                                   *
 * ------------------------------------------------------------------ */

export type StartRunResult = {
  run: AgentRun
  checkpoint: AgentCheckpoint
  artifacts: StructuredArtifact[]
}

export type CancelRunResult = {
  run: AgentRun
}

export type AgentServices = {
  repository: AgentRepository
  startRun(command: StartAgentRunCommand): Promise<{ replayed: boolean; value: StartRunResult }>
  cancelRun(command: CancelAgentRunCommand): { replayed: boolean; value: CancelRunResult }
  /** Load an existing run for inspection (read-only). */
  getRun(runId: string): AgentRun | null
  /** Load run artifacts for inspection (read-only). */
  getArtifactsForRun(runId: string): StructuredArtifact[]
}
