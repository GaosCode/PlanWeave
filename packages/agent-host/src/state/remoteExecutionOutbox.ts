import { stat } from "node:fs/promises";
import { z } from "zod";
import type {
  AgentHostRemoteExecutionIdentity,
  AgentHostRemoteExecutionOutbox,
  AgentHostRemoteExecutionRecord
} from "../execution/remoteAcpPorts.js";
import {
  agentHostRemoteExecutionRecordSchema,
  historicalAgentHostRemoteExecutionRecordSchema,
  type HistoricalAgentHostRemoteExecutionRecord
} from "../execution/remoteExecutionRecordSchema.js";
import { initializeAgentHostStateSchema } from "./agentHostStateMigrations.js";
import {
  inWriteTransaction,
  openAgentHostDatabase,
  openReadonlyAgentHostDatabase,
  type SqliteDatabase
} from "./sqliteDatabase.js";

const recordRowSchema = z.object({ record_json: z.string() });

export type AgentHostRemoteExecutionRetention = {
  maxRecordsPerExecution: number;
  maxRecordBytes: number;
};

export const DEFAULT_REMOTE_EXECUTION_RETENTION: AgentHostRemoteExecutionRetention = {
  maxRecordsPerExecution: 4_096,
  maxRecordBytes: 1_048_576
};

function recordId(record: HistoricalAgentHostRemoteExecutionRecord): string {
  return record.kind === "engine_event" ? String(record.event.sequence) : record.request.requestId;
}

function parseRetention(
  input: Partial<AgentHostRemoteExecutionRetention> = {}
): AgentHostRemoteExecutionRetention {
  const parsed = {
    maxRecordsPerExecution:
      input.maxRecordsPerExecution ?? DEFAULT_REMOTE_EXECUTION_RETENTION.maxRecordsPerExecution,
    maxRecordBytes: input.maxRecordBytes ?? DEFAULT_REMOTE_EXECUTION_RETENTION.maxRecordBytes
  };
  for (const [name, value] of Object.entries(parsed)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`remote_execution_${name}_invalid`);
    }
  }
  return parsed;
}

export class AgentHostRemoteExecutionRecordStore implements AgentHostRemoteExecutionOutbox {
  private readonly retention: AgentHostRemoteExecutionRetention;

  constructor(
    private readonly database: SqliteDatabase,
    options: {
      retention?: Partial<AgentHostRemoteExecutionRetention>;
      requireAuthoritativeExecution?: boolean;
    } = {}
  ) {
    this.retention = parseRetention(options.retention);
    this.requireAuthoritativeExecution = options.requireAuthoritativeExecution ?? false;
  }

  private readonly requireAuthoritativeExecution: boolean;

  append(record: AgentHostRemoteExecutionRecord): void {
    inWriteTransaction(this.database, () => this.appendInCurrentTransaction(record));
  }

  appendInCurrentTransaction(record: AgentHostRemoteExecutionRecord): boolean {
    const parsed = agentHostRemoteExecutionRecordSchema.parse(record);
    return this.insertRecord(parsed, JSON.stringify(parsed));
  }

  importHistoricalInCurrentTransaction(recordJson: string): boolean {
    const record = historicalAgentHostRemoteExecutionRecordSchema.parse(JSON.parse(recordJson));
    return this.insertRecord(record, recordJson);
  }

  private insertRecord(
    parsed: HistoricalAgentHostRemoteExecutionRecord,
    serialized: string
  ): boolean {
    if (Buffer.byteLength(serialized, "utf8") > this.retention.maxRecordBytes) {
      throw new Error("remote_execution_record_too_large");
    }
    if (this.requireAuthoritativeExecution) {
      const execution = this.database
        .prepare(
          `SELECT lease_id FROM agent_host_executions
           WHERE dispatch_id=? AND execution_attempt_id=?`
        )
        .get(parsed.identity.dispatchId, parsed.identity.executionAttemptId);
      if (!execution) throw new Error("remote_execution_not_authoritative");
      if (String(execution.lease_id) !== parsed.identity.leaseId) {
        throw new Error("remote_execution_stale_lease");
      }
    }
    const key = [
      parsed.identity.dispatchId,
      parsed.identity.leaseId,
      parsed.identity.executionAttemptId,
      parsed.kind,
      recordId(parsed)
    ] as const;
    const existing = this.database
      .prepare(
        `SELECT record_json FROM agent_host_remote_execution_outbox
         WHERE dispatch_id=? AND lease_id=? AND execution_attempt_id=?
           AND record_kind=? AND record_id=?`
      )
      .get(...key);
    if (existing) {
      if (recordRowSchema.parse(existing).record_json !== serialized) {
        throw new Error("remote_execution_outbox_conflict");
      }
      return false;
    }
    const count = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_host_remote_execution_outbox
         WHERE dispatch_id=? AND lease_id=? AND execution_attempt_id=?`
      )
      .get(parsed.identity.dispatchId, parsed.identity.leaseId, parsed.identity.executionAttemptId);
    if (Number(count?.count ?? 0) >= this.retention.maxRecordsPerExecution) {
      throw new Error("remote_execution_record_retention_limit_exceeded");
    }
    this.database
      .prepare(
        `INSERT INTO agent_host_remote_execution_outbox(
          dispatch_id,lease_id,execution_attempt_id,record_kind,record_id,record_json,created_at
        ) VALUES(?,?,?,?,?,?,?)`
      )
      .run(...key, serialized, new Date().toISOString());
    return true;
  }

  records(identity: AgentHostRemoteExecutionIdentity): HistoricalAgentHostRemoteExecutionRecord[] {
    return this.database
      .prepare(
        `SELECT record_json FROM agent_host_remote_execution_outbox
         WHERE dispatch_id=? AND lease_id=? AND execution_attempt_id=? ORDER BY sequence`
      )
      .all(identity.dispatchId, identity.leaseId, identity.executionAttemptId)
      .map((row) =>
        historicalAgentHostRemoteExecutionRecordSchema.parse(
          JSON.parse(recordRowSchema.parse(row).record_json)
        )
      );
  }
}

export class AgentHostSqliteRemoteExecutionOutbox implements AgentHostRemoteExecutionOutbox {
  private readonly store: AgentHostRemoteExecutionRecordStore;

  constructor(
    private readonly database: SqliteDatabase,
    retention: Partial<AgentHostRemoteExecutionRetention> = {}
  ) {
    initializeAgentHostStateSchema(database);
    this.store = new AgentHostRemoteExecutionRecordStore(database, { retention });
  }

  close(): void {
    this.database.close();
  }

  append(record: AgentHostRemoteExecutionRecord): void {
    this.store.append(record);
  }

  records(identity: AgentHostRemoteExecutionIdentity): HistoricalAgentHostRemoteExecutionRecord[] {
    return this.store.records(identity);
  }
}

export async function readLegacyRemoteExecutionRecords(
  path: string
): Promise<string[] | undefined> {
  try {
    if (!(await stat(path)).isFile()) return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const database = openReadonlyAgentHostDatabase(path, 5_000);
  try {
    const table = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='agent_host_remote_execution_outbox'"
      )
      .get();
    if (!table) return [];
    return database
      .prepare("SELECT record_json FROM agent_host_remote_execution_outbox ORDER BY sequence")
      .all()
      .map((row) => {
        const serialized = recordRowSchema.parse(row).record_json;
        historicalAgentHostRemoteExecutionRecordSchema.parse(JSON.parse(serialized));
        return serialized;
      });
  } finally {
    database.close();
  }
}

export async function openAgentHostRemoteExecutionOutbox(
  path: string,
  options: {
    busyTimeoutMs?: number;
    retention?: Partial<AgentHostRemoteExecutionRetention>;
  } = {}
): Promise<AgentHostSqliteRemoteExecutionOutbox> {
  const database = await openAgentHostDatabase(path, options.busyTimeoutMs ?? 5_000);
  return new AgentHostSqliteRemoteExecutionOutbox(database, options.retention);
}
