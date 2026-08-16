import { createHash } from "node:crypto";
import { parseAgentHostMailboxCommand } from "../protocol.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqliteDatabase.js";

const CURRENT_AGENT_HOST_STATE_SCHEMA_VERSION = 5;
const INTERMEDIATE_COMPACTION_SCHEMA_VERSION = 4;
const PRE_COMPACTION_SCHEMA_VERSION = 3;

const baseSchema = `
CREATE TABLE IF NOT EXISTS agent_host_inbox (
  sequence INTEGER PRIMARY KEY,
  previous_sequence INTEGER NOT NULL DEFAULT 0,
  message_id TEXT NOT NULL UNIQUE,
  command_json TEXT NOT NULL,
  command_digest TEXT,
  received_at TEXT NOT NULL,
  acknowledged_at TEXT,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_host_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  event_key TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_host_executions (
  inbox_sequence INTEGER PRIMARY KEY REFERENCES agent_host_inbox(sequence),
  dispatch_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  envelope_digest TEXT NOT NULL,
  envelope_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'accepted','preparing','running','interaction_wait','interrupted',
    'completed','failed','cancelled'
  )),
  lease_expires_at TEXT NOT NULL,
  acp_session_id TEXT,
  acp_capabilities_json TEXT,
  recovery_id TEXT,
  event_cursor INTEGER NOT NULL DEFAULT 0 CHECK(event_cursor >= 0),
  action_cursor INTEGER NOT NULL DEFAULT 0 CHECK(action_cursor >= 0),
  cancellation_intent_json TEXT,
  recovery_intent_json TEXT,
  terminal_kind TEXT CHECK(terminal_kind IN ('completed','failed','cancelled')),
  terminal_payload_digest TEXT,
  terminal_event_message_id TEXT,
  terminal_acknowledged_at TEXT,
  received_at TEXT NOT NULL,
  started_at TEXT,
  interrupted_at TEXT,
  finished_at TEXT,
  UNIQUE(dispatch_id,execution_attempt_id),
  CHECK((acp_session_id IS NULL) = (acp_capabilities_json IS NULL)),
  CHECK((terminal_kind IS NULL) = (terminal_payload_digest IS NULL))
);

CREATE TABLE IF NOT EXISTS agent_host_execution_transitions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_sequence INTEGER NOT NULL REFERENCES agent_host_executions(inbox_sequence),
  from_status TEXT,
  to_status TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_host_execution_actions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_sequence INTEGER NOT NULL REFERENCES agent_host_executions(inbox_sequence),
  lease_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK(action_kind IN ('permission','elicitation','authentication')),
  deadline TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_digest TEXT,
  response_json TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(inbox_sequence,session_id,action_id)
);

CREATE TABLE IF NOT EXISTS agent_host_execution_artifacts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_sequence INTEGER NOT NULL REFERENCES agent_host_executions(inbox_sequence),
  operation_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('input','report','output')),
  artifact_ref TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  media_type TEXT NOT NULL,
  transferred_at TEXT NOT NULL,
  UNIQUE(inbox_sequence,operation_id)
);

CREATE TABLE IF NOT EXISTS agent_host_remote_execution_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(dispatch_id,lease_id,execution_attempt_id,record_kind,record_id)
);

CREATE TABLE IF NOT EXISTS agent_host_terminal_execution_receipts (
  dispatch_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  inbox_sequence INTEGER NOT NULL UNIQUE,
  previous_sequence INTEGER NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  command_digest TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  envelope_digest TEXT NOT NULL,
  envelope_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  terminal_kind TEXT NOT NULL CHECK(terminal_kind IN ('completed','failed','cancelled')),
  terminal_payload_digest TEXT NOT NULL,
  terminal_event_message_id TEXT NOT NULL,
  terminal_acknowledged_at TEXT NOT NULL,
  compacted_at TEXT NOT NULL,
  PRIMARY KEY(dispatch_id,execution_attempt_id)
);

CREATE TABLE IF NOT EXISTS agent_host_compacted_mailbox_receipts (
  sequence INTEGER PRIMARY KEY,
  previous_sequence INTEGER NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  command_type TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  compacted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_host_mailbox_checkpoint (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  received_high_water_sequence INTEGER NOT NULL CHECK(received_high_water_sequence >= 0),
  acknowledged_high_water_sequence INTEGER NOT NULL CHECK(acknowledged_high_water_sequence >= 0),
  CHECK(acknowledged_high_water_sequence <= received_high_water_sequence)
);

CREATE TABLE IF NOT EXISTS agent_host_state_schema (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  version INTEGER NOT NULL,
  migrated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_host_outbox_pending
  ON agent_host_outbox(acknowledged_at,sequence);
CREATE INDEX IF NOT EXISTS idx_agent_host_executions_status
  ON agent_host_executions(status,inbox_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_host_execution_transitions
  ON agent_host_execution_transitions(inbox_sequence,sequence);
CREATE INDEX IF NOT EXISTS idx_agent_host_execution_actions
  ON agent_host_execution_actions(inbox_sequence,sequence);
CREATE INDEX IF NOT EXISTS idx_agent_host_execution_artifacts
  ON agent_host_execution_artifacts(inbox_sequence,sequence);
CREATE INDEX IF NOT EXISTS idx_agent_host_remote_execution_identity
  ON agent_host_remote_execution_outbox(dispatch_id,lease_id,execution_attempt_id,sequence);
CREATE INDEX IF NOT EXISTS idx_agent_host_terminal_receipts_age
  ON agent_host_terminal_execution_receipts(compacted_at,inbox_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_host_compacted_mailbox_receipts_age
  ON agent_host_compacted_mailbox_receipts(compacted_at,sequence);
CREATE INDEX IF NOT EXISTS idx_agent_host_compacted_mailbox_receipts_identity
  ON agent_host_compacted_mailbox_receipts(dispatch_id,execution_attempt_id,command_type);
`;

export function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function columns(database: SqliteDatabase, table: string): Set<string> {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name))
  );
}

function assertSupportedSchemaVersion(database: SqliteDatabase): void {
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='agent_host_state_schema'"
    )
    .get();
  if (!table) return;
  const row = database
    .prepare("SELECT version FROM agent_host_state_schema WHERE singleton=1")
    .get();
  if (!row) throw new Error("agent_host_state_schema_version_invalid");
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("agent_host_state_schema_version_invalid");
  }
  if (version === INTERMEDIATE_COMPACTION_SCHEMA_VERSION) {
    throw new Error("agent_host_state_intermediate_compaction_schema_unsupported");
  }
  if (version > CURRENT_AGENT_HOST_STATE_SCHEMA_VERSION) {
    throw new Error("agent_host_state_schema_version_unsupported");
  }
}

function storedSchemaVersion(database: SqliteDatabase): number | undefined {
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='agent_host_state_schema'"
    )
    .get();
  if (!table) return undefined;
  const row = database
    .prepare("SELECT version FROM agent_host_state_schema WHERE singleton=1")
    .get();
  return row ? Number(row.version) : undefined;
}

function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
      .get(table)
  );
}

type RequiredTableShape = {
  columns: readonly string[];
  uniqueKeys: ReadonlyArray<readonly string[]>;
};

const preCompactionRequiredTables: Readonly<Record<string, RequiredTableShape>> = {
  agent_host_inbox: {
    columns: [
      "sequence",
      "previous_sequence",
      "message_id",
      "command_json",
      "command_digest",
      "received_at",
      "acknowledged_at",
      "processed_at"
    ],
    uniqueKeys: [["sequence"], ["message_id"]]
  },
  agent_host_outbox: {
    columns: ["sequence", "message_id", "event_key", "event_json", "created_at", "acknowledged_at"],
    uniqueKeys: [["sequence"], ["message_id"], ["event_key"]]
  },
  agent_host_executions: {
    columns: [
      "inbox_sequence",
      "dispatch_id",
      "lease_id",
      "execution_attempt_id",
      "protocol_version",
      "envelope_digest",
      "envelope_version",
      "workspace_id",
      "agent_profile_id",
      "source_revision",
      "status",
      "lease_expires_at",
      "acp_session_id",
      "acp_capabilities_json",
      "recovery_id",
      "event_cursor",
      "action_cursor",
      "cancellation_intent_json",
      "recovery_intent_json",
      "terminal_kind",
      "terminal_payload_digest",
      "terminal_event_message_id",
      "terminal_acknowledged_at",
      "received_at",
      "started_at",
      "interrupted_at",
      "finished_at"
    ],
    uniqueKeys: [["inbox_sequence"], ["dispatch_id", "execution_attempt_id"]]
  },
  agent_host_execution_transitions: {
    columns: [
      "sequence",
      "inbox_sequence",
      "from_status",
      "to_status",
      "evidence_kind",
      "occurred_at"
    ],
    uniqueKeys: [["sequence"]]
  },
  agent_host_execution_actions: {
    columns: [
      "sequence",
      "inbox_sequence",
      "lease_id",
      "session_id",
      "action_id",
      "action_kind",
      "deadline",
      "request_digest",
      "response_digest",
      "response_json",
      "settled_at",
      "created_at"
    ],
    uniqueKeys: [["sequence"], ["inbox_sequence", "session_id", "action_id"]]
  },
  agent_host_execution_artifacts: {
    columns: [
      "sequence",
      "inbox_sequence",
      "operation_id",
      "direction",
      "artifact_ref",
      "sha256",
      "size_bytes",
      "media_type",
      "transferred_at"
    ],
    uniqueKeys: [["sequence"], ["inbox_sequence", "operation_id"]]
  },
  agent_host_remote_execution_outbox: {
    columns: [
      "sequence",
      "dispatch_id",
      "lease_id",
      "execution_attempt_id",
      "record_kind",
      "record_id",
      "record_json",
      "created_at"
    ],
    uniqueKeys: [
      ["sequence"],
      ["dispatch_id", "lease_id", "execution_attempt_id", "record_kind", "record_id"]
    ]
  },
  agent_host_state_schema: {
    columns: ["singleton", "version", "migrated_at"],
    uniqueKeys: [["singleton"]]
  }
};

const compactionRequiredTables: Readonly<Record<string, RequiredTableShape>> = {
  agent_host_terminal_execution_receipts: {
    columns: [
      "dispatch_id",
      "execution_attempt_id",
      "inbox_sequence",
      "previous_sequence",
      "message_id",
      "command_digest",
      "lease_id",
      "protocol_version",
      "envelope_digest",
      "envelope_version",
      "workspace_id",
      "agent_profile_id",
      "source_revision",
      "terminal_kind",
      "terminal_payload_digest",
      "terminal_event_message_id",
      "terminal_acknowledged_at",
      "compacted_at"
    ],
    uniqueKeys: [["dispatch_id", "execution_attempt_id"], ["inbox_sequence"], ["message_id"]]
  },
  agent_host_mailbox_checkpoint: {
    columns: ["singleton", "received_high_water_sequence", "acknowledged_high_water_sequence"],
    uniqueKeys: [["singleton"]]
  }
};

const currentRequiredTables: Readonly<Record<string, RequiredTableShape>> = {
  ...preCompactionRequiredTables,
  ...compactionRequiredTables,
  agent_host_compacted_mailbox_receipts: {
    columns: [
      "sequence",
      "previous_sequence",
      "message_id",
      "command_type",
      "command_digest",
      "dispatch_id",
      "execution_attempt_id",
      "compacted_at"
    ],
    uniqueKeys: [["sequence"], ["message_id"]]
  }
};

function uniqueKeys(database: SqliteDatabase, table: string): string[][] {
  const primaryKey = database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
  const indexes = database
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .filter((row) => Number(row.unique) === 1)
    .map((row) =>
      database
        .prepare(`PRAGMA index_info(${String(row.name)})`)
        .all()
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((entry) => String(entry.name))
    );
  return primaryKey.length > 0 ? [primaryKey, ...indexes] : indexes;
}

function assertRequiredTablesAndVersion(
  database: SqliteDatabase,
  required: Readonly<Record<string, RequiredTableShape>>,
  expectedVersion: number
): void {
  for (const [table, shape] of Object.entries(required)) {
    const actual = columns(database, table);
    const actualUniqueKeys = uniqueKeys(database, table);
    if (
      shape.columns.some((column) => !actual.has(column)) ||
      shape.uniqueKeys.some(
        (requiredKey) =>
          !actualUniqueKeys.some(
            (actualKey) =>
              requiredKey.length === actualKey.length &&
              requiredKey.every((column, index) => actualKey[index] === column)
          )
      )
    ) {
      throw new Error("agent_host_state_schema_incomplete");
    }
  }
  const schemaRows = database
    .prepare("SELECT singleton,version FROM agent_host_state_schema")
    .all();
  const schemaRow = schemaRows[0];
  if (
    schemaRows.length !== 1 ||
    Number(schemaRow?.singleton) !== 1 ||
    Number(schemaRow?.version) !== expectedVersion
  ) {
    throw new Error("agent_host_state_schema_incomplete");
  }
}

function maxSequence(database: SqliteDatabase, query: string): number {
  const row = database.prepare(query).get();
  const sequence = Number(row?.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("agent_host_state_schema_incomplete");
  }
  return sequence;
}

function assertCheckpointIntegrity(database: SqliteDatabase): void {
  const checkpointRows = database
    .prepare(
      `SELECT singleton,received_high_water_sequence,acknowledged_high_water_sequence
       FROM agent_host_mailbox_checkpoint`
    )
    .all();
  const checkpointRow = checkpointRows[0];
  const receivedHighWater = Number(checkpointRow?.received_high_water_sequence);
  const acknowledgedHighWater = Number(checkpointRow?.acknowledged_high_water_sequence);
  const retainedInboxHighWater = maxSequence(
    database,
    "SELECT COALESCE(MAX(sequence),0) AS sequence FROM agent_host_inbox"
  );
  const acknowledgedInboxHighWater = maxSequence(
    database,
    `SELECT COALESCE(MAX(sequence),0) AS sequence FROM agent_host_inbox
     WHERE acknowledged_at IS NOT NULL`
  );
  const compactedMailboxHighWater = maxSequence(
    database,
    "SELECT COALESCE(MAX(sequence),0) AS sequence FROM agent_host_compacted_mailbox_receipts"
  );
  if (
    checkpointRows.length !== 1 ||
    Number(checkpointRow?.singleton) !== 1 ||
    !Number.isSafeInteger(receivedHighWater) ||
    receivedHighWater < Math.max(retainedInboxHighWater, compactedMailboxHighWater) ||
    !Number.isSafeInteger(acknowledgedHighWater) ||
    acknowledgedHighWater < Math.max(acknowledgedInboxHighWater, compactedMailboxHighWater) ||
    acknowledgedHighWater > receivedHighWater
  ) {
    throw new Error("agent_host_state_schema_incomplete");
  }
}

function assertCurrentSchemaComplete(database: SqliteDatabase): void {
  assertRequiredTablesAndVersion(
    database,
    currentRequiredTables,
    CURRENT_AGENT_HOST_STATE_SCHEMA_VERSION
  );
  assertCheckpointIntegrity(database);
}

function initializeMailboxCheckpoint(database: SqliteDatabase): void {
  const received = database.prepare("SELECT MAX(sequence) AS sequence FROM agent_host_inbox").get();
  const acknowledged = database
    .prepare(
      "SELECT MAX(sequence) AS sequence FROM agent_host_inbox WHERE acknowledged_at IS NOT NULL"
    )
    .get();
  database
    .prepare(
      `INSERT OR IGNORE INTO agent_host_mailbox_checkpoint(
        singleton,received_high_water_sequence,acknowledged_high_water_sequence
      ) VALUES(1,?,?)`
    )
    .run(Number(received?.sequence ?? 0), Number(acknowledged?.sequence ?? 0));
}

function assertNoCompactionSchema(database: SqliteDatabase): void {
  if (
    tableExists(database, "agent_host_terminal_execution_receipts") ||
    tableExists(database, "agent_host_compacted_mailbox_receipts") ||
    tableExists(database, "agent_host_mailbox_checkpoint")
  ) {
    throw new Error("agent_host_state_intermediate_compaction_schema_unsupported");
  }
}

function addLegacyInboxColumns(database: SqliteDatabase): void {
  const inboxColumns = columns(database, "agent_host_inbox");
  if (!inboxColumns.has("previous_sequence")) {
    database.exec(
      "ALTER TABLE agent_host_inbox ADD COLUMN previous_sequence INTEGER NOT NULL DEFAULT 0"
    );
    database.exec(
      `UPDATE agent_host_inbox
       SET previous_sequence=COALESCE((
         SELECT MAX(prior.sequence) FROM agent_host_inbox AS prior
         WHERE prior.sequence<agent_host_inbox.sequence
       ),0)`
    );
  }
  if (!inboxColumns.has("command_digest")) {
    database.exec("ALTER TABLE agent_host_inbox ADD COLUMN command_digest TEXT");
  }
}

function addInteractionSettlementColumns(database: SqliteDatabase): void {
  const actionColumns = columns(database, "agent_host_execution_actions");
  if (!actionColumns.has("response_json")) {
    database.exec("ALTER TABLE agent_host_execution_actions ADD COLUMN response_json TEXT");
  }
}

function backfillCommandDigests(database: SqliteDatabase): void {
  const rows = database
    .prepare("SELECT sequence,command_json FROM agent_host_inbox WHERE command_digest IS NULL")
    .all();
  for (const row of rows) {
    const command = parseAgentHostMailboxCommand(JSON.parse(String(row.command_json)));
    database
      .prepare("UPDATE agent_host_inbox SET command_digest=? WHERE sequence=?")
      .run(digestJson(command), Number(row.sequence));
  }
}

function migratePrototypeExecutions(database: SqliteDatabase): void {
  const inboxColumns = columns(database, "agent_host_inbox");
  if (!inboxColumns.has("execution_status")) return;
  const rows = database
    .prepare(
      `SELECT sequence,command_json,execution_status,lease_expires_at,received_at,
              started_at,finished_at
       FROM agent_host_inbox WHERE execution_status IS NOT NULL`
    )
    .all();
  for (const row of rows) {
    const command = parseAgentHostMailboxCommand(JSON.parse(String(row.command_json)));
    if (command.type !== "execute_block") throw new Error("legacy_execution_command_invalid");
    const legacyStatus = String(row.execution_status);
    const status =
      legacyStatus === "pending"
        ? "accepted"
        : legacyStatus === "cancelling"
          ? "running"
          : legacyStatus;
    const cancellationIntent =
      legacyStatus === "cancelling"
        ? JSON.stringify({ kind: "coordinator_cancel", migrated: true })
        : null;
    const existing = database
      .prepare(
        "SELECT inbox_sequence FROM agent_host_executions WHERE dispatch_id=? AND execution_attempt_id=?"
      )
      .get(command.dispatchId, command.executionAttemptId);
    if (existing && Number(existing.inbox_sequence) !== Number(row.sequence)) {
      throw new Error("legacy_execution_identity_conflict");
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO agent_host_executions(
          inbox_sequence,dispatch_id,lease_id,execution_attempt_id,protocol_version,
          envelope_digest,envelope_version,workspace_id,agent_profile_id,source_revision,
          status,lease_expires_at,cancellation_intent_json,terminal_kind,
          terminal_payload_digest,received_at,started_at,finished_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        Number(row.sequence),
        command.dispatchId,
        command.leaseId,
        command.executionAttemptId,
        command.protocolVersion,
        command.envelopeDigest,
        command.envelope.protocolVersion,
        command.envelope.workspaceId,
        command.envelope.agentProfileId,
        command.envelope.sourceRevision,
        status,
        row.lease_expires_at ? String(row.lease_expires_at) : command.leaseExpiresAt,
        cancellationIntent,
        status === "completed" ? "completed" : status === "failed" ? "failed" : null,
        status === "completed" || status === "failed"
          ? digestJson({ legacyStatus: status, finishedAt: row.finished_at })
          : null,
        String(row.received_at),
        row.started_at ? String(row.started_at) : null,
        row.finished_at ? String(row.finished_at) : null
      );
    database
      .prepare(
        `INSERT INTO agent_host_execution_transitions(
          inbox_sequence,from_status,to_status,evidence_kind,occurred_at
        ) VALUES(?,?,?,?,?)`
      )
      .run(
        Number(row.sequence),
        null,
        status,
        "prototype_migration",
        String(row.started_at ?? row.received_at)
      );
  }
  database.exec(
    `UPDATE agent_host_inbox
     SET execution_status=NULL,lease_expires_at=NULL,started_at=NULL,finished_at=NULL`
  );
}

export function initializeAgentHostStateSchema(database: SqliteDatabase): void {
  inWriteTransaction(database, () => {
    assertSupportedSchemaVersion(database);
    const priorVersion = storedSchemaVersion(database);
    if (priorVersion === CURRENT_AGENT_HOST_STATE_SCHEMA_VERSION) {
      assertCurrentSchemaComplete(database);
    } else {
      assertNoCompactionSchema(database);
      if (priorVersion === PRE_COMPACTION_SCHEMA_VERSION) {
        assertRequiredTablesAndVersion(
          database,
          preCompactionRequiredTables,
          PRE_COMPACTION_SCHEMA_VERSION
        );
      }
    }
    database.exec(baseSchema);
    addLegacyInboxColumns(database);
    addInteractionSettlementColumns(database);
    backfillCommandDigests(database);
    migratePrototypeExecutions(database);
    initializeMailboxCheckpoint(database);
    database
      .prepare(
        `INSERT INTO agent_host_state_schema(singleton,version,migrated_at) VALUES(1,?,?)
         ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,migrated_at=excluded.migrated_at`
      )
      .run(CURRENT_AGENT_HOST_STATE_SCHEMA_VERSION, new Date().toISOString());
    assertCurrentSchemaComplete(database);
  });
}
