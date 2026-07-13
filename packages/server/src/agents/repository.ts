/**
 * A6 repository — read/write helpers for agent tables.
 */

import type { SqliteDatabase } from "../sqlite.js"
import type { UnitOfWork } from "../store.js"
import type {
  AgentCheckpoint,
  AgentRepository,
  AgentRun,
  AgentRunStatus,
  ArtifactKind,
  StructuredArtifact
} from "./types.js"

type AgentRunRow = {
  id: string
  project_id: string
  room_id: string
  status: string
  provider_type: string
  version: number
  created_at: string
  updated_at: string
  cancelled_at: string | null
}

type AgentCheckpointRow = {
  id: string
  run_id: string
  sequence: number
  consumed_cursor: string | null
  message_cursor: string | null
  attachment_cursor: string | null
  artifacts_json: string
  created_at: string
}

type AgentArtifactRow = {
  id: string
  run_id: string
  checkpoint_id: string
  kind: string
  title: string
  body: string
  citations_json: string
  version: number
  created_at: string
  updated_at: string
}

function mapRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    projectId: row.project_id,
    roomId: row.room_id,
    status: row.status as AgentRunStatus,
    providerType: row.provider_type,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at
  }
}

function mapArtifact(row: AgentArtifactRow): StructuredArtifact {
  let citations: Array<{ kind: "message" | "attachment"; id: string }> = []
  try { citations = JSON.parse(row.citations_json) } catch { /* keep empty */ }
  return {
    id: row.id,
    runId: row.run_id,
    checkpointId: row.checkpoint_id,
    kind: row.kind as ArtifactKind,
    title: row.title,
    body: row.body,
    citations,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

type CreateAgentRepositoryOptions = {
  database: SqliteDatabase
}

export function createAgentRepository(options: CreateAgentRepositoryOptions): AgentRepository {
  const { database } = options

  const loadRun = (runId: string): AgentRun | null => {
    const row = database.prepare("SELECT * FROM agent_runs WHERE id=?").get(runId) as AgentRunRow | undefined
    return row ? mapRun(row) : null
  }

  const insertRun: AgentRepository["insertRun"] = (unit, input) => {
    const version = 1
    unit.database
      .prepare("INSERT INTO agent_runs(id,project_id,room_id,status,provider_type,version,created_at,updated_at,cancelled_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(input.id, input.projectId, input.roomId, input.status, input.providerType, version, input.now, input.now, null)
    const created = unit.database
      .prepare("SELECT * FROM agent_runs WHERE id=?")
      .get(input.id) as AgentRunRow | undefined
    if (!created) throw new Error("Inserted agent run row not found.")
    return mapRun(created)
  }

  const updateRun: AgentRepository["updateRun"] = (unit, current, patch, now) => {
    const next: AgentRun = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.cancelledAt !== undefined ? { cancelledAt: patch.cancelledAt } : {}),
      version: current.version + 1,
      updatedAt: now
    }
    unit.database
      .prepare("UPDATE agent_runs SET status=?, version=?, cancelled_at=?, updated_at=? WHERE id=? AND version=?")
      .run(next.status, next.version, next.cancelledAt, next.updatedAt, current.id, current.version)
    return next
  }

  const loadLatestCheckpoint = (unit: UnitOfWork, runId: string): AgentCheckpoint | null => {
    const row = unit.database
      .prepare("SELECT * FROM agent_checkpoints WHERE run_id=? ORDER BY sequence DESC LIMIT 1")
      .get(runId) as AgentCheckpointRow | undefined
    if (!row) return null
    const legacy = row.consumed_cursor?.split(":") ?? []
    return {
      id: row.id,
      runId: row.run_id,
      sequence: Number(row.sequence),
      consumedCursor: row.consumed_cursor,
      messageCursor: row.message_cursor ?? (legacy[0] === "message" ? legacy.slice(1).join(":") : null),
      attachmentCursor: row.attachment_cursor ?? (legacy[0] === "attachment" ? legacy.slice(1).join(":") : null),
      artifactsJson: row.artifacts_json,
      createdAt: row.created_at
    }
  }

  const insertCheckpoint: AgentRepository["insertCheckpoint"] = (unit, input) => {
    unit.database
      .prepare("INSERT INTO agent_checkpoints(id,run_id,sequence,consumed_cursor,artifacts_json,created_at,message_cursor,attachment_cursor) VALUES (?,?,?,?,?,?,?,?)")
      .run(input.id, input.runId, input.sequence, null, input.artifactsJson, input.now, input.messageCursor, input.attachmentCursor)
    const created = unit.database
      .prepare("SELECT * FROM agent_checkpoints WHERE id=?")
      .get(input.id) as AgentCheckpointRow | undefined
    if (!created) throw new Error("Inserted agent checkpoint row not found.")
    const legacy = created.consumed_cursor?.split(":") ?? []
    return {
      id: created.id,
      runId: created.run_id,
      sequence: Number(created.sequence),
      consumedCursor: created.consumed_cursor,
      messageCursor: created.message_cursor ?? (legacy[0] === "message" ? legacy.slice(1).join(":") : null),
      attachmentCursor: created.attachment_cursor ?? (legacy[0] === "attachment" ? legacy.slice(1).join(":") : null),
      artifactsJson: created.artifacts_json,
      createdAt: created.created_at
    }
  }

  const insertArtifact: AgentRepository["insertArtifact"] = (unit, input) => {
    const version = 1
    unit.database
      .prepare("INSERT INTO agent_artifacts(id,run_id,checkpoint_id,kind,title,body,citations_json,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(input.id, input.runId, input.checkpointId, input.kind, input.title, input.body, input.citationsJson, version, input.now, input.now)
    const created = unit.database
      .prepare("SELECT * FROM agent_artifacts WHERE id=?")
      .get(input.id) as AgentArtifactRow | undefined
    if (!created) throw new Error("Inserted agent artifact row not found.")
    return mapArtifact(created)
  }

  const loadArtifactsForRun = (unit: UnitOfWork, runId: string): StructuredArtifact[] => {
    return (unit.database
      .prepare("SELECT * FROM agent_artifacts WHERE run_id=? ORDER BY created_at ASC")
      .all(runId) as AgentArtifactRow[])
      .map(mapArtifact)
  }

  const loadArtifactsForCheckpoint = (unit: UnitOfWork, checkpointId: string): StructuredArtifact[] => {
    return (unit.database
      .prepare("SELECT * FROM agent_artifacts WHERE checkpoint_id=? ORDER BY created_at ASC")
      .all(checkpointId) as AgentArtifactRow[])
      .map(mapArtifact)
  }

  const loadLatestRunForRoom = (roomId: string): AgentRun | null => {
    const row = database
      .prepare("SELECT * FROM agent_runs WHERE room_id=? ORDER BY created_at DESC LIMIT 1")
      .get(roomId) as AgentRunRow | undefined
    return row ? mapRun(row) : null
  }

  return {
    database,
    loadRun,
    insertRun,
    updateRun,
    loadLatestCheckpoint,
    insertCheckpoint,
    insertArtifact,
    loadArtifactsForRun,
    loadArtifactsForCheckpoint,
    loadLatestRunForRoom
  }
}
