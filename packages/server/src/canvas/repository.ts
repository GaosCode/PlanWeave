import { randomUUID } from "node:crypto";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandAcceptedSchema,
  canvasCommandRejectedSchema,
  canvasJournalEntrySchema,
  canvasSnapshotContentSchema,
  canvasSnapshotMetadataSchema,
  type CanvasCommandAccepted,
  type CanvasCommandIntent,
  type CanvasCommandOutcome,
  type CanvasCommandRejected,
  type CanvasJournalEntry,
  type CanvasSnapshotContent
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import { type ActorRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { type PackageSnapshotDigestManifest } from "@planweave-ai/collaboration-protocol/content/snapshot";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import {
  CANVAS_COMMAND_JOURNAL_RETAINED_DEFAULT,
  CANVAS_COMMAND_SNAPSHOT_RETAINED_DEFAULT
} from "./limits.js";
import { CanvasOperationRetention } from "./operationRetention.js";
import { parseCanvasPendingRow } from "./operationReceipt.js";

export { digestCanvasIntent } from "./operationRetention.js";

export type CanvasScopeKey = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
};

export type CanvasHead = {
  revision: number;
  contentDigest: string;
  updatedAt: string;
};

export type CanvasOperationRecord = {
  operationId: string;
  intentDigest: string;
  outcome: CanvasCommandOutcome;
  terminalSequence: number;
  createdAt: string;
};

export type LegacyCanvasBaselineRebase = {
  sourceRevision: number;
  sourceContentDigest: string;
  status: "pending" | "completed";
  reason: "legacy_nondeterministic_layout";
  replacementContentDigest: string | null;
};

const EMPTY_DIGEST = "0".repeat(64);

export type CanvasCommandRepositoryOptions = {
  clock?: () => Date;
  maxJournalEntries?: number;
  maxSnapshots?: number;
  operationRetention?: CanvasOperationRetention;
};

export class CanvasCommandRepository {
  private readonly clock: () => Date;
  private readonly maxJournalEntries: number;
  private readonly maxSnapshots: number;
  readonly operationRetention: CanvasOperationRetention;

  constructor(
    private readonly database: SqliteDatabase,
    options: CanvasCommandRepositoryOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.maxJournalEntries = options.maxJournalEntries ?? CANVAS_COMMAND_JOURNAL_RETAINED_DEFAULT;
    this.maxSnapshots = options.maxSnapshots ?? CANVAS_COMMAND_SNAPSHOT_RETAINED_DEFAULT;
    this.operationRetention =
      options.operationRetention ?? new CanvasOperationRetention(database, this.clock);
    if (!Number.isSafeInteger(this.maxJournalEntries) || this.maxJournalEntries < 1) {
      throw new Error("canvas_journal_retention_invalid");
    }
    if (!Number.isSafeInteger(this.maxSnapshots) || this.maxSnapshots < 1) {
      throw new Error("canvas_snapshot_retention_invalid");
    }
  }

  head(scope: CanvasScopeKey): CanvasHead {
    const row = this.database
      .prepare(
        `SELECT revision,content_digest,updated_at FROM canvas_command_heads
         WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId) as
      | { revision: number; content_digest: string; updated_at: string }
      | undefined;
    if (!row) {
      return { revision: 0, contentDigest: EMPTY_DIGEST, updatedAt: this.clock().toISOString() };
    }
    return {
      revision: Number(row.revision),
      contentDigest: String(row.content_digest),
      updatedAt: String(row.updated_at)
    };
  }

  getOperation(scope: CanvasScopeKey, operationId: string): CanvasOperationRecord | undefined {
    const receipt = this.operationRetention.getReceipt(scope, operationId);
    if (!receipt) return undefined;
    return {
      operationId: receipt.operationId,
      intentDigest: receipt.intentDigest,
      outcome: receipt.outcome,
      terminalSequence: receipt.terminalSequence,
      createdAt: receipt.createdAt
    };
  }

  isLegacyOperationArchived(scope: CanvasScopeKey, operationId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS present FROM canvas_command_legacy_archive
         WHERE workspace_id=? AND project_id=? AND canvas_id=?
           AND record_kind='operation' AND record_key=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, operationId) as
      | { present: number }
      | undefined;
    return row !== undefined;
  }

  listJournalAfter(scope: CanvasScopeKey, afterRevision: number): CanvasJournalEntry[] {
    const rows = this.database
      .prepare(
        `SELECT entry_json FROM canvas_command_journal
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revision>?
         ORDER BY revision ASC`
      )
      .all(scope.workspaceId, scope.projectId, scope.canvasId, afterRevision) as Array<{
      entry_json: string;
    }>;
    return rows.map((row) => canvasJournalEntrySchema.parse(JSON.parse(row.entry_json)));
  }

  oldestRetainedRevision(scope: CanvasScopeKey): number {
    const row = this.database
      .prepare(
        `SELECT MIN(revision) AS revision FROM canvas_command_journal
         WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId) as
      | { revision: number | null }
      | undefined;
    return Number(row?.revision ?? 0);
  }

  journalEntryAt(scope: CanvasScopeKey, revision: number): CanvasJournalEntry | undefined {
    if (revision < 1) return undefined;
    const row = this.database
      .prepare(
        `SELECT entry_json FROM canvas_command_journal
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revision=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, revision) as
      | { entry_json: string }
      | undefined;
    return row ? canvasJournalEntrySchema.parse(JSON.parse(row.entry_json)) : undefined;
  }

  getSnapshot(scope: CanvasScopeKey, revision?: number): CanvasSnapshotContent | undefined {
    const row =
      revision === undefined
        ? (this.database
            .prepare(
              `SELECT * FROM canvas_command_snapshots
               WHERE workspace_id=? AND project_id=? AND canvas_id=?
               ORDER BY revision DESC LIMIT 1`
            )
            .get(scope.workspaceId, scope.projectId, scope.canvasId) as
            | Record<string, unknown>
            | undefined)
        : (this.database
            .prepare(
              `SELECT * FROM canvas_command_snapshots
               WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revision=?`
            )
            .get(scope.workspaceId, scope.projectId, scope.canvasId, revision) as
            | Record<string, unknown>
            | undefined);
    if (!row || row.integrity !== "verified") return undefined;
    return this.snapshotFromRow(scope, row);
  }

  markSnapshotCorrupt(scope: CanvasScopeKey, revision: number): void {
    this.database
      .prepare(
        `UPDATE canvas_command_snapshots SET integrity='corrupt'
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revision=?`
      )
      .run(scope.workspaceId, scope.projectId, scope.canvasId, revision);
  }

  reservePending(input: {
    scope: CanvasScopeKey;
    operationId: string;
    expectedRevision: number;
    intent: CanvasCommandIntent;
    intentDigest: string;
    actor: ActorRef;
  }): void {
    this.operationRetention.assertScopeWritable(input.scope);
    const at = this.clock().toISOString();
    const intentJson = JSON.stringify(input.intent);
    const existingRow = this.database
      .prepare(
        `SELECT operation_id,expected_revision,intent_json,intent_digest,actor_kind,actor_id,
                actor_display_name,reserved_at,status
           FROM canvas_command_pending_scopes
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(input.scope.workspaceId, input.scope.projectId, input.scope.canvasId);
    if (existingRow) {
      const existing = this.pendingFromRow(input.scope, existingRow);
      if (
        existing.operationId !== input.operationId ||
        existing.expectedRevision !== input.expectedRevision ||
        JSON.stringify(existing.intent) !== intentJson ||
        existing.intentDigest !== input.intentDigest ||
        existing.actor.kind !== input.actor.kind ||
        existing.actor.id !== input.actor.id ||
        (existing.actor.displayName ?? null) !== (input.actor.displayName ?? null)
      ) {
        this.operationRetention.corruption(input.scope, "canvas_command_pending_scope_conflict");
      }
      this.database
        .prepare(
          `UPDATE canvas_command_pending_scopes SET status='applying',reserved_at=?
            WHERE workspace_id=? AND project_id=? AND canvas_id=?`
        )
        .run(at, input.scope.workspaceId, input.scope.projectId, input.scope.canvasId);
      return;
    }
    this.database
      .prepare(
        `INSERT INTO canvas_command_pending_scopes(
          workspace_id,project_id,canvas_id,operation_id,expected_revision,
          intent_json,intent_digest,actor_kind,actor_id,actor_display_name,reserved_at,status
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?, 'applying')`
      )
      .run(
        input.scope.workspaceId,
        input.scope.projectId,
        input.scope.canvasId,
        input.operationId,
        input.expectedRevision,
        intentJson,
        input.intentDigest,
        input.actor.kind,
        input.actor.id,
        input.actor.displayName ?? null,
        at
      );
  }

  clearPending(scope: CanvasScopeKey, operationId: string): void {
    this.database
      .prepare(
        `DELETE FROM canvas_command_pending_scopes
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?`
      )
      .run(scope.workspaceId, scope.projectId, scope.canvasId, operationId);
  }

  listNeedsRecovery(limit = 100): Array<{
    scope: CanvasScopeKey;
    operationId: string;
    expectedRevision: number;
    intent: CanvasCommandIntent;
    intentDigest: string;
    actor: ActorRef;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) {
      throw new Error("canvas_command_recovery_limit_invalid");
    }
    if (limit === 0) return [];
    const rows = this.database
      .prepare(
        `SELECT pending.workspace_id,pending.project_id,pending.canvas_id,pending.operation_id,
                pending.expected_revision,pending.intent_json,pending.intent_digest,
                pending.actor_kind,pending.actor_id,pending.actor_display_name,
                pending.reserved_at,pending.status
         FROM canvas_command_pending_scopes AS pending
         LEFT JOIN canvas_command_operation_retention_scopes AS retention
           ON retention.workspace_id=pending.workspace_id
          AND retention.project_id=pending.project_id
          AND retention.canvas_id=pending.canvas_id
         WHERE retention.status IS NULL OR retention.status!='repair_required'
         ORDER BY pending.workspace_id,pending.project_id,pending.canvas_id
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      this.pendingFromRow(
        {
          workspaceId: String(row.workspace_id),
          projectId: String(row.project_id),
          canvasId: String(row.canvas_id)
        },
        row
      )
    );
  }

  private pendingFromRow(scope: CanvasScopeKey, row: Record<string, unknown>) {
    try {
      return parseCanvasPendingRow(scope, row);
    } catch (cause) {
      this.operationRetention.corruption(scope, "canvas_command_pending_corrupt", cause);
    }
  }

  hasPendingRecovery(scope: CanvasScopeKey): boolean {
    const row = this.database
      .prepare(
        `SELECT operation_id,expected_revision,intent_json,intent_digest,actor_kind,actor_id,
                actor_display_name,reserved_at,status
           FROM canvas_command_pending_scopes
         WHERE workspace_id=? AND project_id=? AND canvas_id=?
         LIMIT 1`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId);
    if (!row) return false;
    this.pendingFromRow(scope, row);
    return true;
  }

  legacyBaselineRebase(scope: CanvasScopeKey): LegacyCanvasBaselineRebase | null {
    const row = this.database
      .prepare(
        `SELECT source_revision,source_content_digest,status,reason,replacement_content_digest
           FROM canvas_command_baseline_rebases
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      sourceRevision: Number(row.source_revision),
      sourceContentDigest: String(row.source_content_digest),
      status: String(row.status) as LegacyCanvasBaselineRebase["status"],
      reason: String(row.reason) as LegacyCanvasBaselineRebase["reason"],
      replacementContentDigest:
        row.replacement_content_digest == null ? null : String(row.replacement_content_digest)
    };
  }

  completeLegacyBaselineRebase(
    scope: CanvasScopeKey,
    replacement: {
      contentDigest: string;
      digestManifest: PackageSnapshotDigestManifest;
      sizeBytes: number;
    }
  ): CanvasHead {
    return inWriteTransaction(this.database, () => {
      const rebase = this.legacyBaselineRebase(scope);
      if (!rebase) throw new Error("canvas_baseline_rebase_not_pending");
      if (rebase.status === "completed") {
        if (rebase.replacementContentDigest !== replacement.contentDigest) {
          throw new Error("canvas_baseline_rebase_replacement_conflict");
        }
        return this.head(scope);
      }
      const head = this.head(scope);
      if (
        head.revision !== rebase.sourceRevision ||
        head.contentDigest !== rebase.sourceContentDigest
      ) {
        throw new Error("canvas_baseline_rebase_source_changed");
      }

      const archivedAt = this.clock().toISOString();
      const archive = this.database.prepare(
        `INSERT INTO canvas_command_legacy_archive(
           workspace_id,project_id,canvas_id,record_kind,record_key,record_json,archived_at,reason
         ) VALUES(?,?,?,?,?,?,?,'legacy_nondeterministic_layout')
         ON CONFLICT(workspace_id,project_id,canvas_id,record_kind,record_key) DO NOTHING`
      );
      const archiveTable = (
        table: string,
        kind: "journal" | "operation" | "snapshot" | "pending",
        keyColumn: string
      ) => {
        const rows = this.database
          .prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND project_id=? AND canvas_id=?`)
          .all(scope.workspaceId, scope.projectId, scope.canvasId) as Array<
          Record<string, unknown>
        >;
        for (const row of rows) {
          archive.run(
            scope.workspaceId,
            scope.projectId,
            scope.canvasId,
            kind,
            String(row[keyColumn]),
            JSON.stringify(row),
            archivedAt
          );
        }
      };
      archiveTable("canvas_command_journal", "journal", "revision");
      archiveTable("canvas_command_operations", "operation", "operation_id");
      archiveTable("canvas_command_operation_receipts", "operation", "operation_id");
      archiveTable("canvas_command_snapshots", "snapshot", "revision");
      archiveTable("canvas_command_pending", "pending", "operation_id");
      archiveTable("canvas_command_pending_scopes", "pending", "operation_id");

      for (const table of [
        "canvas_command_journal",
        "canvas_command_operations",
        "canvas_command_operation_receipts",
        "canvas_command_snapshots",
        "canvas_command_pending",
        "canvas_command_pending_scopes"
      ]) {
        this.database
          .prepare(`DELETE FROM ${table} WHERE workspace_id=? AND project_id=? AND canvas_id=?`)
          .run(scope.workspaceId, scope.projectId, scope.canvasId);
      }
      this.operationRetention.recordBaselineResetInCallerTransaction(scope);
      this.database
        .prepare(
          `UPDATE canvas_command_heads
              SET content_digest=?,updated_at=?
            WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revision=?`
        )
        .run(
          replacement.contentDigest,
          archivedAt,
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          head.revision
        );
      this.database
        .prepare(
          `INSERT INTO canvas_command_snapshots(
             workspace_id,project_id,canvas_id,revision,content_digest,created_at,
             package_snapshot_id,digest_manifest_json,size_bytes,encoding,integrity
          ) VALUES(?,?,?,?,?,?,NULL,?,?,'content_version_ref','verified')`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          head.revision,
          replacement.contentDigest,
          archivedAt,
          JSON.stringify(replacement.digestManifest),
          replacement.sizeBytes
        );
      this.database
        .prepare(
          `UPDATE canvas_command_baseline_rebases
              SET status='completed',completed_at=?,replacement_content_digest=?
            WHERE workspace_id=? AND project_id=? AND canvas_id=? AND status='pending'`
        )
        .run(
          archivedAt,
          replacement.contentDigest,
          scope.workspaceId,
          scope.projectId,
          scope.canvasId
        );
      return this.head(scope);
    });
  }

  markPendingNeedsRecovery(scope: CanvasScopeKey, operationId: string): void {
    this.database
      .prepare(
        `UPDATE canvas_command_pending_scopes SET status='needs_recovery'
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?`
      )
      .run(scope.workspaceId, scope.projectId, scope.canvasId, operationId);
  }

  /**
   * Persist accepted outcome atomically: journal entry, head, operation, snapshot, retention.
   */
  commitAccepted(input: {
    scope: CanvasScopeKey;
    operationId: string;
    intent: CanvasCommandIntent;
    intentDigest: string;
    actor: ActorRef;
    previousRevision: number;
    expectedContentDigest?: string;
    revision: number;
    contentDigest: string;
    digestManifest?: PackageSnapshotDigestManifest;
    sizeBytes?: number;
    packageSnapshotId?: string;
  }): CanvasCommandAccepted {
    return inWriteTransaction(this.database, () => this.commitAcceptedInCallerTransaction(input));
  }

  /** Storage adapter boundary for coordinated authority commits. */
  commitAcceptedInCallerTransaction(input: {
    scope: CanvasScopeKey;
    operationId: string;
    intent: CanvasCommandIntent;
    intentDigest: string;
    actor: ActorRef;
    previousRevision: number;
    expectedContentDigest?: string;
    revision: number;
    contentDigest: string;
    digestManifest?: PackageSnapshotDigestManifest;
    sizeBytes?: number;
    packageSnapshotId?: string;
  }): CanvasCommandAccepted {
    const acceptedAt = this.clock().toISOString();
    const entryId = `journal-${randomUUID()}`;
    const journalEntry = canvasJournalEntrySchema.parse({
      schemaVersion: "canvas-journal/v1",
      entryId,
      scope: {
        workspaceId: input.scope.workspaceId,
        projectId: input.scope.projectId,
        canvasId: input.scope.canvasId
      },
      revision: input.revision,
      previousRevision: input.previousRevision,
      operationId: input.operationId,
      intent: input.intent,
      intentDigest: input.intentDigest,
      contentDigest: input.contentDigest,
      actor: input.actor,
      acceptedAt
    });
    const accepted = canvasCommandAcceptedSchema.parse({
      type: "canvas.command.accepted",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: journalEntry.scope,
      operationId: input.operationId,
      revision: input.revision,
      previousRevision: input.previousRevision,
      contentDigest: input.contentDigest,
      journalEntryId: entryId,
      actor: input.actor,
      acceptedAt,
      idempotentReplay: false
    });

    this.database
      .prepare(
        `INSERT INTO canvas_command_journal(
            workspace_id,project_id,canvas_id,entry_id,revision,previous_revision,operation_id,
            intent_json,intent_digest,content_digest,actor_kind,actor_id,actor_display_name,
            accepted_at,entry_json
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.scope.workspaceId,
        input.scope.projectId,
        input.scope.canvasId,
        entryId,
        input.revision,
        input.previousRevision,
        input.operationId,
        JSON.stringify(input.intent),
        input.intentDigest,
        input.contentDigest,
        input.actor.kind,
        input.actor.id,
        input.actor.displayName ?? null,
        acceptedAt,
        JSON.stringify(journalEntry)
      );

    const headWrite = this.database
      .prepare(
        `INSERT INTO canvas_command_heads(workspace_id,project_id,canvas_id,revision,content_digest,updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(workspace_id,project_id,canvas_id) DO UPDATE SET
           revision=excluded.revision,
           content_digest=excluded.content_digest,
           updated_at=excluded.updated_at
         WHERE canvas_command_heads.revision=? AND canvas_command_heads.content_digest=?`
      )
      .run(
        input.scope.workspaceId,
        input.scope.projectId,
        input.scope.canvasId,
        input.revision,
        input.contentDigest,
        acceptedAt,
        input.previousRevision,
        input.expectedContentDigest ?? this.head(input.scope).contentDigest
      );
    if (headWrite.changes !== 1) throw new Error("canvas_command_head_cas_conflict");

    this.operationRetention.recordTerminalInCallerTransaction({
      scope: input.scope,
      operationId: input.operationId,
      intentDigest: input.intentDigest,
      outcome: accepted,
      createdAt: acceptedAt
    });

    // Snapshots retain only metadata. The canonical baseline is always addressed by
    // the immutable content-version id derived from content_digest.
    const encoding = "content_version_ref";
    this.database
      .prepare(
        `INSERT INTO canvas_command_snapshots(
            workspace_id,project_id,canvas_id,revision,content_digest,created_at,
            package_snapshot_id,digest_manifest_json,size_bytes,encoding,integrity
          ) VALUES(?,?,?,?,?,?,?,?,?,?, 'verified')
          ON CONFLICT(workspace_id,project_id,canvas_id,revision) DO UPDATE SET
            content_digest=excluded.content_digest,
            created_at=excluded.created_at,
            package_snapshot_id=excluded.package_snapshot_id,
            digest_manifest_json=excluded.digest_manifest_json,
            size_bytes=excluded.size_bytes,
            encoding=excluded.encoding,
            integrity='verified'`
      )
      .run(
        input.scope.workspaceId,
        input.scope.projectId,
        input.scope.canvasId,
        input.revision,
        input.contentDigest,
        acceptedAt,
        input.packageSnapshotId ?? null,
        input.digestManifest ? JSON.stringify(input.digestManifest) : null,
        input.sizeBytes ?? null,
        encoding
      );

    this.trimJournal(input.scope);
    this.trimSnapshots(input.scope);
    this.clearPending(input.scope, input.operationId);

    return accepted;
  }

  storeRejected(input: {
    scope: CanvasScopeKey;
    operationId: string;
    intent: CanvasCommandIntent;
    intentDigest: string;
    rejected: CanvasCommandRejected;
  }): void {
    const at = this.clock().toISOString();
    // Only cache terminal non-CAS rejections for idempotency when intent matches.
    // stale_revision is not stored as a permanent outcome (revision moves).
    if (input.rejected.code !== "invalid_command") return;
    inWriteTransaction(this.database, () => {
      this.operationRetention.recordTerminalInCallerTransaction({
        scope: input.scope,
        operationId: input.operationId,
        intentDigest: input.intentDigest,
        outcome: canvasCommandRejectedSchema.parse(input.rejected),
        createdAt: at
      });
      this.clearPending(input.scope, input.operationId);
    });
  }

  ensureInitialHead(
    scope: CanvasScopeKey,
    contentDigest: string,
    snapshot?: { digestManifest: PackageSnapshotDigestManifest; sizeBytes: number }
  ): CanvasHead {
    const existing = this.head(scope);
    if (existing.revision > 0) return existing;
    const at = this.clock().toISOString();
    inWriteTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO canvas_command_heads(workspace_id,project_id,canvas_id,revision,content_digest,updated_at)
           VALUES(?,?,?,0,?,?)
           ON CONFLICT(workspace_id,project_id,canvas_id) DO NOTHING`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          contentDigest === EMPTY_DIGEST ? EMPTY_DIGEST : contentDigest,
          at
        );
      if (contentDigest !== EMPTY_DIGEST) {
        this.database
          .prepare(
            `INSERT INTO canvas_command_snapshots(
              workspace_id,project_id,canvas_id,revision,content_digest,created_at,
              package_snapshot_id,digest_manifest_json,size_bytes,encoding,integrity
            ) VALUES(?,?,?,0,?,?,NULL,?,?,'content_version_ref','verified')
            ON CONFLICT(workspace_id,project_id,canvas_id,revision) DO NOTHING`
          )
          .run(
            scope.workspaceId,
            scope.projectId,
            scope.canvasId,
            contentDigest,
            at,
            snapshot ? JSON.stringify(snapshot.digestManifest) : null,
            snapshot?.sizeBytes ?? null
          );
      }
    });
    return this.head(scope);
  }

  private trimJournal(scope: CanvasScopeKey): void {
    this.database
      .prepare(
        `DELETE FROM canvas_command_journal
         WHERE workspace_id=? AND project_id=? AND canvas_id=?
           AND revision NOT IN (
             SELECT revision FROM canvas_command_journal
             WHERE workspace_id=? AND project_id=? AND canvas_id=?
             ORDER BY revision DESC LIMIT ?
           )`
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        this.maxJournalEntries
      );
  }

  private trimSnapshots(scope: CanvasScopeKey): void {
    this.database
      .prepare(
        `DELETE FROM canvas_command_snapshots
         WHERE workspace_id=? AND project_id=? AND canvas_id=?
           AND revision NOT IN (
             SELECT revision FROM canvas_command_snapshots
             WHERE workspace_id=? AND project_id=? AND canvas_id=?
             ORDER BY revision DESC LIMIT ?
           )`
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        this.maxSnapshots
      );
  }

  private snapshotFromRow(
    scope: CanvasScopeKey,
    row: Record<string, unknown>
  ): CanvasSnapshotContent | undefined {
    try {
      if (row.encoding !== "content_version_ref") {
        throw new Error("canvas_snapshot_encoding_unsupported");
      }
      const metadata = canvasSnapshotMetadataSchema.parse({
        schemaVersion: "canvas-snapshot/v2",
        scope: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          canvasId: scope.canvasId
        },
        revision: Number(row.revision),
        contentDigest: String(row.content_digest),
        createdAt: String(row.created_at),
        sizeBytes:
          row.size_bytes === null || row.size_bytes === undefined
            ? undefined
            : Number(row.size_bytes)
      });
      return canvasSnapshotContentSchema.parse({
        metadata,
        encoding: "content_version_ref",
        content: {
          versionId: `version-${metadata.contentDigest}`,
          canonicalDigest: metadata.contentDigest,
          verification: "complete"
        }
      });
    } catch {
      this.markSnapshotCorrupt(scope, Number(row.revision));
      return undefined;
    }
  }
}

export function rejectedOutcome(input: {
  projectId: string;
  canvasId: string;
  operationId: string;
  code: CanvasCommandRejected["code"];
  detail?: string;
  conflict?: CanvasCommandRejected["conflict"];
}): CanvasCommandRejected {
  return canvasCommandRejectedSchema.parse({
    type: "canvas.command.rejected",
    protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
    schemaVersion: "canvas-command/v1",
    projectId: input.projectId,
    canvasId: input.canvasId,
    operationId: input.operationId,
    code: input.code,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.conflict ? { conflict: input.conflict } : {})
  });
}
