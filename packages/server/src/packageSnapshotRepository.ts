import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createPackageSnapshotResultSchema,
  packageSnapshotSchema,
  restorePackageSnapshotResultSchema,
  type CreatePackageSnapshotResult,
  type PackageSnapshot,
  type RestorePackageSnapshotResult
} from "@planweave-ai/collaboration-protocol/content/snapshot";
import {
  canvasScopeRefSchema,
  type ActorRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CapturedPackageSnapshot } from "@planweave-ai/runtime";
import type { CanvasPackageSnapshotRuntimePort } from "./canvas/runtimePort.js";
import { ProjectAccessRepository } from "./projectAccessRepository.js";
import {
  assertCapturedSnapshotIntegrity,
  backingPath,
  capturedSnapshotSchema,
  fingerprint,
  maxBackingBytes,
  snapshotId,
  stableStringify
} from "./packageSnapshotBacking.js";
import { enforcePackageSnapshotRetention } from "./packageSnapshotRetention.js";
import type { SqliteDatabase } from "./sqlite.js";

function metadataFromRow(row: Record<string, unknown>): PackageSnapshot {
  return packageSnapshotSchema.parse({
    schemaVersion: "package-snapshot/v1",
    immutable: {
      snapshotId: row.snapshot_id,
      registry: {
        projectRegistryId: row.project_registry_id,
        canvasRegistryId: row.canvas_registry_id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        canvasId: row.canvas_id
      },
      sourceRevision: row.source_revision,
      createdAt: row.created_at,
      creator: { kind: row.creator_kind, id: row.creator_id },
      digestManifest: JSON.parse(String(row.digest_manifest_json)),
      migrationMarker: row.migration_marker
    },
    mutable: {
      state: row.state,
      aclRevision: Number(row.acl_revision),
      visibility: { project: row.project_visibility, canvas: row.canvas_visibility },
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at,
      retentionOrder: row.retention_order === null ? null : Number(row.retention_order),
      restoreMarker: row.restore_marker
    }
  });
}

/** Server-side immutable Plan Package snapshot metadata and backing. */
export class PackageSnapshotRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly access: ProjectAccessRepository,
    private readonly dataDirectory: string,
    private readonly runtime: CanvasPackageSnapshotRuntimePort,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async create(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    actor: ActorRef;
    expectedAclRevision: number;
  }): Promise<CreatePackageSnapshotResult> {
    const canvasDecision = this.access.decideCanvasAccess({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      actor: input.actor
    });
    if (canvasDecision.decision !== "allow")
      throw new Error(`canvas_access_denied:${canvasDecision.reason}`);
    if (input.expectedAclRevision !== canvasDecision.aclRevision)
      throw new Error("snapshot_stale_acl_revision");
    this.access.policy.assertCanManage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      actor: input.actor
    });
    const scope = canvasScopeRefSchema.parse({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId
    });
    const captured = capturedSnapshotSchema.parse(await this.runtime.captureSnapshot(scope));
    const canvas = this.access.registry.canvasInternal(
      input.workspaceId,
      input.projectId,
      input.canvasId
    );
    const project = this.access.registry.projectInternal(input.workspaceId, input.projectId);
    if (!canvas || !project) throw new Error("canvas_registry_not_found");
    const digestFingerprint = fingerprint(captured.digestManifest);
    const id = snapshotId(canvas.canvasRegistryId, captured.sourceRevision, digestFingerprint);
    const at = this.clock().toISOString();
    const dir = backingPath(this.dataDirectory, id);
    const existing = this.database
      .prepare("SELECT * FROM package_snapshots WHERE snapshot_id=?")
      .get(id) as Record<string, unknown> | undefined;
    let wroteBacking = false;
    if (existing) {
      if (String(existing.content_root_internal) !== dir)
        throw new Error("package_snapshot_backing_conflict");
      if (
        existing.digest_fingerprint !== digestFingerprint ||
        existing.digest_manifest_json !== stableStringify(captured.digestManifest) ||
        existing.source_revision !== captured.sourceRevision
      )
        throw new Error("package_snapshot_immutable_conflict");
      try {
        const backingPathname = join(String(existing.content_root_internal), "package.json");
        const backingStat = await stat(backingPathname);
        if (backingStat.size > maxBackingBytes)
          throw new Error("package_snapshot_backing_conflict");
        const backing = capturedSnapshotSchema.parse(
          JSON.parse(await readFile(backingPathname, "utf8"))
        );
        if (stableStringify(backing) !== stableStringify(captured))
          throw new Error("package_snapshot_backing_conflict");
      } catch (error) {
        throw new Error(
          error instanceof Error && error.message === "package_snapshot_backing_conflict"
            ? error.message
            : "package_snapshot_backing_missing"
        );
      }
    } else {
      await mkdir(dirname(dir), { recursive: true });
      const temp = `${dir}.tmp-${process.pid}-${Date.now()}`;
      await mkdir(temp, { recursive: true });
      try {
        const payload = {
          sourceRevision: captured.sourceRevision,
          digestManifest: captured.digestManifest,
          files: captured.files
        };
        const serializedPayload = JSON.stringify(payload);
        if (Buffer.byteLength(serializedPayload, "utf8") > maxBackingBytes)
          throw new Error("snapshot_envelope_too_large");
        await writeFile(join(temp, "package.json"), serializedPayload, "utf8");
        await rename(temp, dir);
        wroteBacking = true;
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
    try {
      if (!existing) {
        const retentionOrder = 1;
        this.database
          .prepare(`INSERT INTO package_snapshots(
        snapshot_id,project_registry_id,canvas_registry_id,workspace_id,project_id,canvas_id,
        source_revision,digest_manifest_json,digest_fingerprint,content_root_internal,
        creator_kind,creator_id,migration_marker,state,acl_revision,project_visibility,
        canvas_visibility,created_at,updated_at,revoked_at,retention_order,restore_marker
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            id,
            project.projectRegistryId,
            canvas.canvasRegistryId,
            input.workspaceId,
            input.projectId,
            input.canvasId,
            captured.sourceRevision,
            stableStringify(captured.digestManifest),
            digestFingerprint,
            dir,
            input.actor.kind,
            input.actor.id,
            "digest_verified",
            "available",
            canvasDecision.aclRevision,
            project.visibility,
            canvas.visibility,
            at,
            at,
            null,
            retentionOrder,
            "none"
          );
      }
    } catch (error) {
      if (wroteBacking) await rm(dir, { recursive: true, force: true });
      throw error;
    }
    await enforcePackageSnapshotRetention(
      this.database,
      this.dataDirectory,
      canvas.canvasRegistryId,
      at
    );
    const snapshot = metadataFromRow(
      this.database
        .prepare("SELECT * FROM package_snapshots WHERE snapshot_id=?")
        .get(id) as Record<string, unknown>
    );
    return createPackageSnapshotResultSchema.parse({
      snapshot,
      actor: input.actor,
      scope
    });
  }

  read(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    snapshotId: string;
    actor: ActorRef;
  }): PackageSnapshot {
    const decision = this.access.decideCanvasAccess(input);
    if (decision.decision !== "allow") throw new Error(`canvas_access_denied:${decision.reason}`);
    const row = this.database
      .prepare(
        "SELECT * FROM package_snapshots WHERE snapshot_id=? AND workspace_id=? AND project_id=? AND canvas_id=?"
      )
      .get(input.snapshotId, input.workspaceId, input.projectId, input.canvasId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error("package_snapshot_not_found");
    if (String(row.content_root_internal) !== backingPath(this.dataDirectory, input.snapshotId))
      throw new Error("package_snapshot_not_found");
    return metadataFromRow(row);
  }

  async restore(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    snapshotId: string;
    actor: ActorRef;
    expectedAclRevision: number;
  }): Promise<RestorePackageSnapshotResult> {
    const decision = this.access.decideCanvasAccess(input);
    const scope = canvasScopeRefSchema.parse({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId
    });
    const base = {
      schemaVersion: "package-snapshot/v1" as const,
      snapshotId: input.snapshotId,
      scope,
      actor: input.actor,
      aclRevision: decision.aclRevision
    };
    if (decision.decision !== "allow")
      return restorePackageSnapshotResultSchema.parse({
        ...base,
        outcome: "missing",
        migrationMarker: "none",
        sourceRevision: null,
        restoredAt: null,
        detail: "canvas_access_denied"
      });
    this.access.policy.assertCanManage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      actor: input.actor
    });
    if (decision.aclRevision !== input.expectedAclRevision)
      return restorePackageSnapshotResultSchema.parse({
        ...base,
        outcome: "conflict",
        migrationMarker: "none",
        sourceRevision: null,
        restoredAt: null,
        detail: "stale_acl_revision"
      });
    const row = this.database
      .prepare(
        "SELECT * FROM package_snapshots WHERE snapshot_id=? AND workspace_id=? AND project_id=? AND canvas_id=?"
      )
      .get(input.snapshotId, input.workspaceId, input.projectId, input.canvasId) as
      | Record<string, unknown>
      | undefined;
    if (!row)
      return restorePackageSnapshotResultSchema.parse({
        ...base,
        outcome: "missing",
        migrationMarker: "none",
        sourceRevision: null,
        restoredAt: null,
        detail: "snapshot_not_found"
      });
    const snapshot = metadataFromRow(row);
    if (snapshot.mutable.state !== "available")
      return restorePackageSnapshotResultSchema.parse({
        ...base,
        outcome: snapshot.mutable.state,
        migrationMarker: snapshot.immutable.migrationMarker,
        sourceRevision: snapshot.immutable.sourceRevision,
        restoredAt: null,
        detail: "snapshot_unavailable"
      });
    const restoreStartedAt = this.clock().toISOString();
    const restoreClaim = this.database
      .prepare(
        "UPDATE package_snapshots SET restore_marker='restore_pending',updated_at=? WHERE snapshot_id=? AND workspace_id=? AND project_id=? AND canvas_id=? AND state='available' AND restore_marker='none'"
      )
      .run(restoreStartedAt, input.snapshotId, input.workspaceId, input.projectId, input.canvasId);
    if (restoreClaim.changes !== 1)
      return restorePackageSnapshotResultSchema.parse({
        ...base,
        outcome: "conflict",
        migrationMarker: snapshot.immutable.migrationMarker,
        sourceRevision: snapshot.immutable.sourceRevision,
        restoredAt: null,
        detail: "restore_pending"
      });

    const recoverMarker = (state: "available" | "malformed"): boolean => {
      try {
        const recovered = this.database
          .prepare(
            `UPDATE package_snapshots SET state=?,restore_marker='none',updated_at=?
             WHERE snapshot_id=? AND workspace_id=? AND project_id=? AND canvas_id=?
               AND state='available' AND restore_marker='restore_pending'`
          )
          .run(
            state,
            this.clock().toISOString(),
            input.snapshotId,
            input.workspaceId,
            input.projectId,
            input.canvasId
          );
        return recovered.changes === 1;
      } catch {
        return false;
      }
    };

    const resultAfterFailure = (input: {
      outcome: "conflict" | "malformed";
      detail: string;
      state: "available" | "malformed";
      aggregate: boolean;
    }): RestorePackageSnapshotResult => {
      const recovered = input.aggregate ? false : recoverMarker(input.state);
      return restorePackageSnapshotResultSchema.parse({
        ...base,
        outcome: recovered && !input.aggregate ? input.outcome : "malformed",
        migrationMarker: snapshot.immutable.migrationMarker,
        sourceRevision: snapshot.immutable.sourceRevision,
        restoredAt: null,
        detail: recovered && !input.aggregate ? input.detail : "snapshot_restore_recovery_required"
      });
    };

    let captured: CapturedPackageSnapshot;
    try {
      const expectedBackingRoot = backingPath(this.dataDirectory, input.snapshotId);
      if (String(row.content_root_internal) !== expectedBackingRoot)
        throw new Error("snapshot_backing_mismatch");
      const packageFile = join(expectedBackingRoot, "package.json");
      const metadata = await stat(packageFile);
      if (metadata.size > maxBackingBytes) throw new Error("snapshot_backing_too_large");
      captured = capturedSnapshotSchema.parse(JSON.parse(await readFile(packageFile, "utf8")));
      assertCapturedSnapshotIntegrity(captured);
      if (
        captured.sourceRevision !== String(row.source_revision) ||
        fingerprint(captured.digestManifest) !== row.digest_fingerprint ||
        stableStringify(captured.digestManifest) !== row.digest_manifest_json
      )
        throw new Error(
          captured.sourceRevision !== String(row.source_revision)
            ? "snapshot_source_revision_mismatch"
            : "snapshot_digest_mismatch"
        );
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const detail = [
        "snapshot_backing_too_large",
        "snapshot_source_revision_mismatch",
        "snapshot_digest_mismatch",
        "snapshot_file_set_mismatch",
        "snapshot_digest_manifest_mismatch",
        "snapshot_backing_mismatch"
      ].includes(code)
        ? code
        : "snapshot_backing_missing";
      return resultAfterFailure({
        outcome: "malformed",
        detail,
        state: "malformed",
        aggregate: false
      });
    }
    try {
      const assertRestoreAuthorization = () => {
        const currentDecision = this.access.decideCanvasAccess(input);
        if (currentDecision.decision !== "allow")
          throw new Error("snapshot_restore_authorization_conflict");
        try {
          this.access.policy.assertCanManage({
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            canvasId: input.canvasId,
            actor: input.actor
          });
        } catch {
          throw new Error("snapshot_restore_authorization_conflict");
        }
        if (currentDecision.aclRevision !== input.expectedAclRevision)
          throw new Error("snapshot_restore_acl_conflict");
      };
      await this.runtime.restoreSnapshot({
        scope,
        snapshot: captured,
        beforeCommit: assertRestoreAuthorization
      });
    } catch (error) {
      const aggregate = error instanceof AggregateError;
      const code = error instanceof Error ? error.message : "";
      if (code === "snapshot_restore_authorization_conflict") {
        return resultAfterFailure({
          outcome: "conflict",
          detail: "authorization_changed",
          state: "available",
          aggregate
        });
      }
      if (code === "snapshot_restore_acl_conflict") {
        return resultAfterFailure({
          outcome: "conflict",
          detail: "stale_acl_revision",
          state: "available",
          aggregate
        });
      }
      if (code === "canvas_runtime_unavailable") {
        return resultAfterFailure({
          outcome: "conflict",
          detail: "canvas_runtime_unavailable",
          state: "available",
          aggregate
        });
      }
      return resultAfterFailure({
        outcome: "malformed",
        detail: "snapshot_restore_failed",
        state: "available",
        aggregate
      });
    }
    const restoredAt = this.clock().toISOString();
    const completed = this.database
      .prepare(
        "UPDATE package_snapshots SET restore_marker='restore_complete',updated_at=? WHERE snapshot_id=? AND workspace_id=? AND project_id=? AND canvas_id=? AND state='available' AND restore_marker='restore_pending'"
      )
      .run(restoredAt, input.snapshotId, input.workspaceId, input.projectId, input.canvasId);
    if (completed.changes !== 1)
      return restorePackageSnapshotResultSchema.parse({
        ...base,
        outcome: "conflict",
        migrationMarker: snapshot.immutable.migrationMarker,
        sourceRevision: snapshot.immutable.sourceRevision,
        restoredAt: null,
        detail: "restore_completion_conflict"
      });
    return restorePackageSnapshotResultSchema.parse({
      ...base,
      outcome: "restored",
      migrationMarker: snapshot.immutable.migrationMarker,
      sourceRevision: snapshot.immutable.sourceRevision,
      restoredAt,
      detail: null
    });
  }

  async revoke(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    snapshotId: string;
    actor: ActorRef;
    expectedAclRevision: number;
  }): Promise<void> {
    this.access.policy.assertCanManage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      actor: input.actor
    });
    const decision = this.access.decideCanvasAccess(input);
    if (decision.decision !== "allow") throw new Error("snapshot_not_found");
    if (decision.aclRevision !== input.expectedAclRevision)
      throw new Error("snapshot_stale_acl_revision");
    const row = this.database
      .prepare(
        "SELECT snapshot_id,content_root_internal,state,restore_marker FROM package_snapshots WHERE snapshot_id=? AND workspace_id=? AND project_id=? AND canvas_id=?"
      )
      .get(input.snapshotId, input.workspaceId, input.projectId, input.canvasId) as
      | {
          snapshot_id: string;
          content_root_internal: string;
          state: string;
          restore_marker: string;
        }
      | undefined;
    if (!row) throw new Error("snapshot_not_found");
    const expectedBackingRoot = backingPath(this.dataDirectory, input.snapshotId);
    if (row.content_root_internal !== expectedBackingRoot) throw new Error("snapshot_not_found");
    if (row.state === "available" && row.restore_marker === "restore_pending")
      throw new Error("snapshot_restore_pending");
    const at = this.clock().toISOString();
    const result = this.database
      .prepare(
        "UPDATE package_snapshots SET state='revoked',revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE snapshot_id=? AND workspace_id=? AND project_id=? AND canvas_id=? AND state<>'revoked' AND restore_marker<>'restore_pending'"
      )
      .run(at, at, input.snapshotId, input.workspaceId, input.projectId, input.canvasId);
    if (row.state !== "revoked" && result.changes !== 1)
      throw new Error("snapshot_revoke_conflict");
    await rm(expectedBackingRoot, { recursive: true, force: true });
  }
}
