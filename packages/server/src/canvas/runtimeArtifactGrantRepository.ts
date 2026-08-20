import { createHash } from "node:crypto";
import {
  canvasRuntimeArtifactTransferDescriptorSchema,
  canvasRuntimeGraphFingerprintSchema,
  canvasRuntimeLeaseIdSchema,
  canvasRuntimeLogicalScopeSchema,
  canvasRuntimeSourceRevisionSchema,
  canonicalizeJson,
  type CanvasRuntimeArtifactTransferDescriptor,
  type CanvasRuntimeLogicalScope
} from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import type { ArtifactMetadata } from "../artifacts.js";
import { artifactMediaTypeSchema } from "../artifactMediaType.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const grantIdSchema = z.string().regex(/^runtime-artifact-[a-f0-9]{64}$/);

export type ServerCanvasRuntimeLease = CanvasRuntimeLogicalScope & {
  runtimeLeaseId: string;
  hostId: string;
  attachmentVersion: number;
  sourceRevision: string;
  graphFingerprint: string;
  expiresAt: string;
  status: "active" | "released" | "revoked";
};

type GrantInput = {
  runtimeLeaseId: string;
  operationId: string;
  artifactRef: string;
  sha256: string;
  mediaType: string;
  expiresAt: string;
};

type RuntimeArtifactGrantRepositoryOptions = {
  maxArtifactBytes: number;
  clock?: () => Date;
  leaseActive(lease: ServerCanvasRuntimeLease): boolean;
};

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalizeJson(input)).digest("hex");
}

function grantId(input: unknown): string {
  return grantIdSchema.parse(`runtime-artifact-${digest(input)}`);
}

function artifactRef(sha256: string): string {
  return `artifact:sha256:${sha256Schema.parse(sha256)}`;
}

export class RuntimeArtifactGrantRepository {
  private readonly clock: () => Date;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly options: RuntimeArtifactGrantRepositoryOptions
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  revokeActiveAfterRestart(): void {
    const now = this.clock().toISOString();
    inWriteTransaction(this.database, () => {
      this.database
        .prepare(
          "UPDATE canvas_runtime_leases SET status='revoked',updated_at=? WHERE status='active'"
        )
        .run(now);
      this.database
        .prepare(
          "UPDATE canvas_runtime_artifact_grants SET revoked_at=?,updated_at=? WHERE revoked_at IS NULL"
        )
        .run(now, now);
    });
  }

  recordLease(input: Omit<ServerCanvasRuntimeLease, "status">): ServerCanvasRuntimeLease {
    const scope = canvasRuntimeLogicalScopeSchema.parse({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId
    });
    const lease = {
      ...scope,
      runtimeLeaseId: canvasRuntimeLeaseIdSchema.parse(input.runtimeLeaseId),
      hostId: z.string().min(1).parse(input.hostId),
      attachmentVersion: z.number().int().nonnegative().parse(input.attachmentVersion),
      sourceRevision: canvasRuntimeSourceRevisionSchema.parse(input.sourceRevision),
      graphFingerprint: canvasRuntimeGraphFingerprintSchema.parse(input.graphFingerprint),
      expiresAt: z.iso.datetime().parse(input.expiresAt),
      status: "active" as const
    };
    const now = this.clock().toISOString();
    const existing = this.lease(lease.runtimeLeaseId);
    if (existing) {
      if (digest(existing) !== digest(lease))
        throw new Error("canvas_runtime_lease_identity_conflict");
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO canvas_runtime_leases(
          runtime_lease_id,host_id,workspace_id,project_id,canvas_id,attachment_version,
          source_revision,graph_fingerprint,expires_at,status,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)`
      )
      .run(
        lease.runtimeLeaseId,
        lease.hostId,
        lease.workspaceId,
        lease.projectId,
        lease.canvasId,
        lease.attachmentVersion,
        lease.sourceRevision,
        lease.graphFingerprint,
        lease.expiresAt,
        now,
        now
      );
    return lease;
  }

  lease(runtimeLeaseId: string): ServerCanvasRuntimeLease | undefined {
    const row = this.database
      .prepare("SELECT * FROM canvas_runtime_leases WHERE runtime_lease_id=?")
      .get(canvasRuntimeLeaseIdSchema.parse(runtimeLeaseId));
    if (!row) return undefined;
    return {
      runtimeLeaseId: String(row.runtime_lease_id),
      hostId: String(row.host_id),
      workspaceId: String(row.workspace_id),
      projectId: String(row.project_id),
      canvasId: String(row.canvas_id),
      attachmentVersion: Number(row.attachment_version),
      sourceRevision: String(row.source_revision),
      graphFingerprint: String(row.graph_fingerprint),
      expiresAt: String(row.expires_at),
      status: z.enum(["active", "released", "revoked"]).parse(row.status)
    };
  }

  createDownloadGrant(
    input: GrantInput & { sizeBytes: number }
  ): CanvasRuntimeArtifactTransferDescriptor {
    return this.createGrant("download", input, input.sizeBytes);
  }

  createUploadGrant(
    input: GrantInput & { maxSizeBytes: number }
  ): CanvasRuntimeArtifactTransferDescriptor {
    return this.createGrant("upload", input, input.maxSizeBytes);
  }

  private createGrant(
    direction: "download" | "upload",
    input: GrantInput,
    sizeLimit: number
  ): CanvasRuntimeArtifactTransferDescriptor {
    const lease = this.requireActiveLease(input.runtimeLeaseId);
    const sha256 = sha256Schema.parse(input.sha256);
    if (input.artifactRef !== artifactRef(sha256)) throw new Error("runtime_artifact_ref_mismatch");
    const mediaType = artifactMediaTypeSchema.parse(input.mediaType);
    const boundedSize = z
      .number()
      .int()
      .positive()
      .max(this.options.maxArtifactBytes)
      .parse(sizeLimit);
    const expiresAt = z.iso.datetime().parse(input.expiresAt);
    if (
      Date.parse(expiresAt) > Date.parse(lease.expiresAt) ||
      Date.parse(expiresAt) <= this.clock().getTime()
    ) {
      throw new Error("runtime_artifact_grant_expiry_invalid");
    }
    const request = {
      direction,
      runtimeLeaseId: lease.runtimeLeaseId,
      operationId: input.operationId,
      artifactRef: input.artifactRef,
      sha256,
      mediaType,
      sizeLimit,
      expiresAt
    };
    const id = grantId({
      direction,
      runtimeLeaseId: lease.runtimeLeaseId,
      operationId: input.operationId
    });
    const requestDigest = digest(request);
    const existing = this.database
      .prepare("SELECT request_digest FROM canvas_runtime_artifact_grants WHERE grant_id=?")
      .get(id);
    if (existing) {
      if (existing.request_digest !== requestDigest)
        throw new Error("runtime_artifact_grant_identity_conflict");
    } else {
      const now = this.clock().toISOString();
      this.database
        .prepare(
          `INSERT INTO canvas_runtime_artifact_grants(
            grant_id,request_digest,runtime_lease_id,direction,artifact_ref,sha256,
            expected_size_bytes,max_size_bytes,media_type,expires_at,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          requestDigest,
          lease.runtimeLeaseId,
          direction,
          input.artifactRef,
          sha256,
          direction === "download" ? boundedSize : null,
          boundedSize,
          mediaType,
          expiresAt,
          now,
          now
        );
    }
    return canvasRuntimeArtifactTransferDescriptorSchema.parse({
      version: "canvas-runtime-artifact-transfer/v1",
      grantId: id,
      direction,
      runtimeLeaseId: lease.runtimeLeaseId,
      artifactRef: input.artifactRef,
      sha256,
      mediaType,
      expiresAt,
      ...(direction === "download" ? { sizeBytes: boundedSize } : { maxSizeBytes: boundedSize })
    });
  }

  authorizeDownload(input: {
    hostId: string;
    runtimeLeaseId: string;
    grantId: string;
    sha256: string;
  }) {
    const grant = this.requireGrant(input, "download");
    const sizeBytes = Number(grant.expected_size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1)
      throw new Error("runtime_artifact_grant_invalid");
    return {
      artifactRef: String(grant.artifact_ref),
      sizeBytes,
      mediaType: String(grant.media_type)
    };
  }

  authorizeUpload(input: {
    hostId: string;
    runtimeLeaseId: string;
    grantId: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
  }) {
    return inWriteTransaction(this.database, () => {
      const grant = this.requireGrant(input, "upload");
      const mediaType = artifactMediaTypeSchema.parse(input.mediaType);
      if (
        mediaType !== grant.media_type ||
        input.sizeBytes < 1 ||
        input.sizeBytes > Number(grant.max_size_bytes)
      ) {
        throw new Error("runtime_artifact_upload_evidence_mismatch");
      }
      if (
        grant.expected_size_bytes !== null &&
        Number(grant.expected_size_bytes) !== input.sizeBytes
      ) {
        throw new Error("runtime_artifact_grant_identity_conflict");
      }
      this.database
        .prepare(
          `UPDATE canvas_runtime_artifact_grants SET expected_size_bytes=?,updated_at=?
           WHERE grant_id=? AND expected_size_bytes IS NULL`
        )
        .run(input.sizeBytes, this.clock().toISOString(), input.grantId);
      return { artifactRef: String(grant.artifact_ref), mediaType };
    });
  }

  acceptUpload(
    input: { hostId: string; runtimeLeaseId: string; grantId: string; sha256: string },
    artifact: ArtifactMetadata
  ): void {
    inWriteTransaction(this.database, () => {
      // Re-authorize after the request body has been persisted. A lease may be
      // released or detached while a PUT is still streaming.
      const grant = this.requireGrant(input, "upload");
      if (
        artifact.ref !== grant.artifact_ref ||
        artifact.sha256 !== grant.sha256 ||
        artifact.sizeBytes !== Number(grant.expected_size_bytes) ||
        artifact.mediaType !== grant.media_type
      ) {
        throw new Error("runtime_artifact_upload_evidence_mismatch");
      }
      if (grant.consumed_at !== null) return;
      this.database
        .prepare(
          "UPDATE canvas_runtime_artifact_grants SET consumed_at=?,updated_at=? WHERE grant_id=?"
        )
        .run(this.clock().toISOString(), this.clock().toISOString(), input.grantId);
    });
  }

  releaseLease(runtimeLeaseId: string): void {
    const id = canvasRuntimeLeaseIdSchema.parse(runtimeLeaseId);
    const now = this.clock().toISOString();
    inWriteTransaction(this.database, () => {
      this.database
        .prepare(
          "UPDATE canvas_runtime_leases SET status='released',updated_at=? WHERE runtime_lease_id=?"
        )
        .run(now, id);
      this.database
        .prepare(
          "UPDATE canvas_runtime_artifact_grants SET revoked_at=?,updated_at=? WHERE runtime_lease_id=? AND revoked_at IS NULL"
        )
        .run(now, now, id);
    });
  }

  private requireGrant(
    input: { hostId: string; runtimeLeaseId: string; grantId: string; sha256: string },
    direction: "download" | "upload"
  ): Record<string, unknown> {
    const lease = this.requireActiveLease(input.runtimeLeaseId);
    if (lease.hostId !== input.hostId) throw new Error("runtime_artifact_scope_forbidden");
    const grant = this.database
      .prepare("SELECT * FROM canvas_runtime_artifact_grants WHERE grant_id=?")
      .get(grantIdSchema.parse(input.grantId));
    if (
      !grant ||
      grant.runtime_lease_id !== lease.runtimeLeaseId ||
      grant.direction !== direction ||
      grant.sha256 !== sha256Schema.parse(input.sha256) ||
      grant.revoked_at !== null ||
      Date.parse(String(grant.expires_at)) <= this.clock().getTime()
    ) {
      throw new Error("runtime_artifact_scope_forbidden");
    }
    return grant;
  }

  private requireActiveLease(runtimeLeaseId: string): ServerCanvasRuntimeLease {
    const lease = this.lease(runtimeLeaseId);
    if (
      !lease ||
      lease.status !== "active" ||
      Date.parse(lease.expiresAt) <= this.clock().getTime() ||
      !this.options.leaseActive(lease)
    ) {
      throw new Error("runtime_artifact_scope_forbidden");
    }
    return lease;
  }
}
