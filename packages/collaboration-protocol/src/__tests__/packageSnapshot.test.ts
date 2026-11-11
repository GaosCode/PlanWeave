import { describe, expect, it } from "vitest";
import { contentVersionMemberPathSchema } from "../contentVersion.js";
import {
  packageSnapshotDigestManifestSchema,
  packageSnapshotRelativePathSchema,
  packageSnapshotSchema,
  restorePackageSnapshotRequestSchema,
  restorePackageSnapshotResultSchema
} from "../packageSnapshot.js";
import { examplePackageSnapshot } from "../fixtures/collaboration.js";

const actor = { kind: "human" as const, id: "human-owner-001", displayName: "Owner" };
const scope = {
  workspaceId: "workspace-demo-001",
  projectId: "project-demo-001",
  canvasId: "canvas-default"
};
const registry = {
  projectRegistryId: "registry-project-001",
  canvasRegistryId: "registry-canvas-001",
  workspaceId: scope.workspaceId,
  projectId: scope.projectId,
  canvasId: scope.canvasId
};
const digest = "a".repeat(64);
const manifest = {
  manifest: { digestSha256: digest, sizeBytes: 120 },
  prompts: [
    { path: "nodes/OSS-002/prompt.md", digest: { digestSha256: "b".repeat(64), sizeBytes: 240 } }
  ],
  totalBytes: 360
};

describe("Plan Package snapshot contracts", () => {
  it.each([
    ["255-byte leaf", `${"a".repeat(252)}.md`, null],
    ["256-byte leaf", `${"a".repeat(253)}.md`, "package_path_segment_too_long"],
    ["256-byte directory", `${"a".repeat(256)}/prompt.md`, "package_path_segment_too_long"],
    ["512-byte path", `${"a".repeat(255)}/d/${"b".repeat(251)}.md`, null],
    ["513-byte path", `${"a".repeat(255)}/d/${"b".repeat(252)}.md`, "too_big"]
  ] as const)("enforces the shared segment and total limits for a %s", (_name, path, error) => {
    for (const schema of [contentVersionMemberPathSchema, packageSnapshotRelativePathSchema]) {
      const result = schema.safeParse(path);
      if (error === null) {
        expect(result).toMatchObject({ success: true, data: path });
      } else if (error === "too_big") {
        expect(result).toMatchObject({ success: false, error: { issues: [{ code: error }] } });
      } else {
        expect(result).toMatchObject({ success: false, error: { issues: [{ message: error }] } });
      }
    }
  });

  it("binds immutable digest metadata to a source revision and creator", () => {
    expect(examplePackageSnapshot.immutable.snapshotId).toBe("snapshot-demo-001");
    const snapshot = packageSnapshotSchema.parse({
      schemaVersion: "package-snapshot/v1",
      immutable: {
        snapshotId: "snapshot-001",
        registry,
        sourceRevision: "git:abc123",
        createdAt: "2030-01-01T00:00:00.000Z",
        creator: actor,
        digestManifest: manifest,
        migrationMarker: "digest_verified"
      },
      mutable: {
        state: "available",
        aclRevision: 2,
        visibility: { project: "shared", canvas: "shared" },
        updatedAt: "2030-01-01T00:00:00.000Z",
        revokedAt: null,
        retentionOrder: 1,
        restoreMarker: "none"
      }
    });
    expect(snapshot.immutable.digestManifest.prompts[0]?.digest.sizeBytes).toBe(240);
    expect(snapshot.mutable.visibility.canvas).toBe("shared");
    expect(
      packageSnapshotSchema.parse({
        schemaVersion: "package-snapshot/v1",
        immutable: snapshot.immutable,
        mutable: { ...snapshot.mutable, visibility: { project: "private", canvas: "shared" } }
      }).mutable.visibility
    ).toEqual({ project: "private", canvas: "shared" });
  });

  it("rejects path traversal, duplicate prompt entries, and understated sizes", () => {
    expect(() => packageSnapshotRelativePathSchema.parse("../../etc/passwd")).toThrow();
    expect(() => packageSnapshotRelativePathSchema.parse("/srv/package/manifest.json")).toThrow();
    expect(() => packageSnapshotRelativePathSchema.parse("nodes//prompt.md")).toThrow();
    expect(() =>
      packageSnapshotDigestManifestSchema.parse({
        ...manifest,
        prompts: [...manifest.prompts, ...manifest.prompts]
      })
    ).toThrow();
    expect(() =>
      packageSnapshotDigestManifestSchema.parse({ ...manifest, totalBytes: 1 })
    ).toThrow();
  });

  it("makes missing/revoked/stale/malformed and restore outcomes explicit", () => {
    expect(
      restorePackageSnapshotRequestSchema.parse({
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        snapshotId: "snapshot-001",
        expectedAclRevision: 2
      }).snapshotId
    ).toBe("snapshot-001");
    for (const outcome of ["missing", "revoked", "stale", "malformed"] as const) {
      const parsed = restorePackageSnapshotResultSchema.parse({
        schemaVersion: "package-snapshot/v1",
        outcome,
        snapshotId: "snapshot-001",
        scope,
        actor,
        aclRevision: 3,
        migrationMarker: "digest_verified",
        sourceRevision: null,
        restoredAt: null,
        detail: outcome
      });
      expect(parsed.outcome).toBe(outcome);
    }
    expect(() =>
      restorePackageSnapshotResultSchema.parse({
        schemaVersion: "package-snapshot/v1",
        outcome: "restored",
        snapshotId: "snapshot-001",
        scope,
        actor,
        aclRevision: 3,
        migrationMarker: "digest_verified",
        sourceRevision: null,
        restoredAt: null,
        detail: null
      })
    ).toThrow();
  });

  it("does not accept filesystem paths or secret metadata in snapshot records", () => {
    expect(() =>
      restorePackageSnapshotRequestSchema.parse({
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        snapshotId: "snapshot-001",
        expectedAclRevision: 2,
        projectRoot: "/srv/planweave"
      })
    ).toThrow();
    expect(() =>
      packageSnapshotSchema.parse({
        schemaVersion: "package-snapshot/v1",
        immutable: {
          snapshotId: "snapshot-001",
          registry,
          sourceRevision: "../../secret",
          createdAt: "2030-01-01T00:00:00.000Z",
          creator: actor,
          digestManifest: manifest,
          migrationMarker: "digest_verified"
        },
        mutable: {
          state: "available",
          aclRevision: 2,
          visibility: { project: "private", canvas: "private" },
          updatedAt: "2030-01-01T00:00:00.000Z",
          revokedAt: null,
          retentionOrder: null,
          restoreMarker: "none"
        }
      })
    ).toThrow();
    expect(() =>
      packageSnapshotSchema.parse({
        schemaVersion: "package-snapshot/v1",
        projectRoot: "/srv/planweave",
        immutable: {
          snapshotId: "snapshot-001",
          registry,
          sourceRevision: "git:abc123",
          createdAt: "2030-01-01T00:00:00.000Z",
          creator: actor,
          digestManifest: manifest,
          migrationMarker: "digest_verified",
          secret: "nope"
        },
        mutable: {
          state: "available",
          aclRevision: 2,
          visibility: { project: "private", canvas: "private" },
          updatedAt: "2030-01-01T00:00:00.000Z",
          revokedAt: null,
          retentionOrder: null,
          restoreMarker: "none"
        },
        token: "secret"
      })
    ).toThrow();
  });
});
