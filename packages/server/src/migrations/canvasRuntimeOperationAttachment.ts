import { readStableCanvasRuntimeContentTarget } from "../canvas/contentFingerprint.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import type { SqliteDatabase } from "../sqlite.js";
import { columnExists, tableExists } from "./schemaIntrospection.js";
import type { Migration } from "./types.js";

const attachmentTableSql = `
  CREATE TABLE canvas_runtime_operation_attachments (
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    canvas_id TEXT NOT NULL,
    operation_id TEXT NOT NULL REFERENCES remote_operations(id) ON DELETE CASCADE,
    execution_attempt_id TEXT NOT NULL
      REFERENCES remote_execution_attempts(execution_attempt_id) ON DELETE CASCADE,
    host_id TEXT NOT NULL REFERENCES agent_hosts(id),
    host_generation TEXT NOT NULL REFERENCES agent_hosts(id),
    content_revision INTEGER NOT NULL CHECK(content_revision >= 0),
    graph_fingerprint TEXT NOT NULL CHECK(length(trim(graph_fingerprint)) > 0),
    reservation_lease_id TEXT NOT NULL,
    attached_at TEXT NOT NULL,
    PRIMARY KEY(operation_id,execution_attempt_id)
  );
`;

type LegacyEvidenceRow = {
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  operation_id: string;
  execution_attempt_id: string;
  host_id: string;
  host_generation: string;
  content_revision: number;
  graph_fingerprint: string;
  reservation_lease_id: string;
  attached_at: string;
};

type StableContentTarget = ReturnType<typeof readStableCanvasRuntimeContentTarget>;

const unverifiableContentTargetErrors = new Set([
  "canvas_content_head_missing",
  "canvas_content_head_changed",
  "content_version_not_found",
  "content_version_member_missing",
  "content_version_member_size_mismatch",
  "content_version_member_digest_mismatch",
  "content_version_canonical_digest_mismatch",
  "content_version_prompt_kind_conflict",
  "content_version_prompt_set_mismatch",
  "content_version_semantic_validation_failed"
]);

function isUnverifiableContentTargetError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (unverifiableContentTargetErrors.has(error.message) ||
      error.message.startsWith("content_version_member_missing:") ||
      error.message.startsWith("canvas_replica_"))
  );
}

function readProvableLegacyContentTarget(
  contentVersions: ContentVersionRepository,
  candidate: LegacyEvidenceRow
): StableContentTarget | undefined {
  try {
    return readStableCanvasRuntimeContentTarget(contentVersions, {
      workspaceId: candidate.workspace_id,
      projectId: candidate.project_id,
      canvasId: candidate.canvas_id
    });
  } catch (error) {
    if (isUnverifiableContentTargetError(error)) return undefined;
    throw error;
  }
}

function prepareRuntimeOperationAttachments(database: SqliteDatabase): void {
  const evidenceColumns = [
    "operation_id",
    "execution_attempt_id",
    "host_generation",
    "content_revision",
    "graph_fingerprint"
  ];
  const missingEvidenceColumns = evidenceColumns.filter(
    (column) => !columnExists(database, "canvas_runtime_host_bindings", column)
  );
  if (missingEvidenceColumns.length > 0) {
    throw new Error(
      `canvas_runtime_host_binding_evidence_schema_missing:${missingEvidenceColumns.join(",")}`
    );
  }
  if (!columnExists(database, "canvas_runtime_host_bindings", "route_selected")) {
    database.exec(
      "ALTER TABLE canvas_runtime_host_bindings ADD COLUMN route_selected INTEGER NOT NULL DEFAULT 0 CHECK(route_selected IN (0,1))"
    );
  }
  database.exec(attachmentTableSql);
  if (!tableExists(database, "host_capacity_reservations")) return;
  const candidates = database
    .prepare(
      `SELECT binding.workspace_id,binding.project_id,attempt.canvas_id,
         binding.operation_id,binding.execution_attempt_id,binding.host_id,
         binding.host_generation,binding.content_revision,binding.graph_fingerprint,
         reservation.lease_id AS reservation_lease_id,binding.last_observed_at AS attached_at
       FROM canvas_runtime_host_bindings binding
       JOIN remote_operations operation
         ON operation.id=binding.operation_id
        AND operation.workspace_id=binding.workspace_id
        AND operation.project_id=binding.project_id
        AND operation.execution_attempt_id=binding.execution_attempt_id
        AND operation.source_fingerprint=binding.graph_fingerprint
       JOIN remote_execution_attempts attempt
         ON attempt.execution_attempt_id=binding.execution_attempt_id
        AND attempt.operation_id=binding.operation_id
        AND attempt.workspace_id=binding.workspace_id
        AND attempt.project_id=binding.project_id
        AND attempt.host_id=binding.host_id
       JOIN host_capacity_reservations reservation
         ON reservation.execution_attempt_id=attempt.execution_attempt_id
        AND reservation.lease_id=attempt.lease_id
        AND reservation.host_id=binding.host_id
       JOIN agent_hosts host
         ON host.id=binding.host_id
        AND host.id=binding.host_generation
       WHERE binding.operation_id IS NOT NULL
         AND binding.execution_attempt_id IS NOT NULL
         AND binding.host_generation IS NOT NULL
         AND binding.content_revision IS NOT NULL
         AND binding.content_revision >= 0
         AND binding.graph_fingerprint IS NOT NULL
         AND length(trim(binding.graph_fingerprint)) > 0`
    )
    .all() as LegacyEvidenceRow[];
  const contentVersions = new ContentVersionRepository(database);
  const insert = database.prepare(
    `INSERT OR IGNORE INTO canvas_runtime_operation_attachments(
       workspace_id,project_id,canvas_id,operation_id,execution_attempt_id,
       host_id,host_generation,content_revision,graph_fingerprint,
       reservation_lease_id,attached_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const candidate of candidates) {
    const target = readProvableLegacyContentTarget(contentVersions, candidate);
    if (!target) continue;
    if (
      target.revision !== candidate.content_revision ||
      target.graphFingerprint !== candidate.graph_fingerprint
    ) {
      continue;
    }
    insert.run(
      candidate.workspace_id,
      candidate.project_id,
      candidate.canvas_id,
      candidate.operation_id,
      candidate.execution_attempt_id,
      candidate.host_id,
      candidate.host_generation,
      candidate.content_revision,
      candidate.graph_fingerprint,
      candidate.reservation_lease_id,
      candidate.attached_at
    );
  }
}

export const canvasRuntimeOperationAttachmentMigration: Migration = {
  version: 64,
  before: prepareRuntimeOperationAttachments,
  sql: `
    CREATE INDEX idx_canvas_runtime_operation_attachment_scope
      ON canvas_runtime_operation_attachments(workspace_id,project_id,canvas_id,attached_at);
    CREATE INDEX idx_canvas_runtime_operation_attachment_attempt
      ON canvas_runtime_operation_attachments(execution_attempt_id);
    CREATE INDEX idx_canvas_runtime_operation_attachment_host_generation
      ON canvas_runtime_operation_attachments(host_id,host_generation,attached_at);

    DROP INDEX IF EXISTS idx_canvas_runtime_host_binding_selected_route;
    CREATE TABLE canvas_runtime_host_bindings_v64_new (
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      host_id TEXT NOT NULL REFERENCES agent_hosts(id),
      readiness_status TEXT NOT NULL CHECK(readiness_status IN ('ready','missing','invalid')),
      route_selected INTEGER NOT NULL DEFAULT 0 CHECK(route_selected IN (0,1)),
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,project_id,host_id)
    );
    INSERT INTO canvas_runtime_host_bindings_v64_new(
      workspace_id,project_id,host_id,readiness_status,route_selected,
      first_observed_at,last_observed_at
    )
    SELECT workspace_id,project_id,host_id,readiness_status,route_selected,
      first_observed_at,last_observed_at
    FROM canvas_runtime_host_bindings;
    DROP TABLE canvas_runtime_host_bindings;
    ALTER TABLE canvas_runtime_host_bindings_v64_new RENAME TO canvas_runtime_host_bindings;
    CREATE INDEX idx_canvas_runtime_host_bindings_host
      ON canvas_runtime_host_bindings(host_id,workspace_id,project_id);
    CREATE UNIQUE INDEX idx_canvas_runtime_host_binding_selected_route
      ON canvas_runtime_host_bindings(workspace_id,project_id)
      WHERE route_selected=1;
  `
};
