import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { applyMigrations } from "../migrations.js";
import { RuntimeArtifactGrantRepository } from "../canvas/runtimeArtifactGrantRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = { workspaceId: "workspace-a", projectId: "project-a", canvasId: "default" };
const sourceRevision = `snapshot:${"b".repeat(64)}`;
const graphFingerprint = `pkg-${"a".repeat(64)}`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const host = new AgentHostRepository(database).register("Runtime Host").host;
  let active = true;
  const grants = new RuntimeArtifactGrantRepository(database, {
    maxArtifactBytes: 1024,
    leaseActive: () => active
  });
  grants.recordLease({
    runtimeLeaseId: "runtime-lease-a",
    hostId: host.id,
    ...scope,
    attachmentVersion: 0,
    sourceRevision,
    graphFingerprint,
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  return { database, grants, host, deactivate: () => (active = false) };
}

describe("RuntimeArtifactGrantRepository", () => {
  it("replays identical grants and rejects changed evidence for the same operation", async () => {
    const { grants } = await setup();
    const sha256 = "c".repeat(64);
    const input = {
      runtimeLeaseId: "runtime-lease-a",
      operationId: "complete-operation-a",
      artifactRef: `artifact:sha256:${sha256}`,
      sha256,
      sizeBytes: 42,
      mediaType: "text/plain",
      expiresAt: "2098-01-01T00:00:00.000Z"
    };
    const first = grants.createDownloadGrant(input);
    expect(grants.createDownloadGrant(input)).toEqual(first);
    expect(() => grants.createDownloadGrant({ ...input, sizeBytes: 43 })).toThrow(
      "runtime_artifact_grant_identity_conflict"
    );
  });

  it("binds upload size on first authorization and rejects cross-host or changed evidence", async () => {
    const { grants, host, deactivate } = await setup();
    const sha256 = "d".repeat(64);
    const transfer = grants.createUploadGrant({
      runtimeLeaseId: "runtime-lease-a",
      operationId: "artifact-read-a",
      artifactRef: `artifact:sha256:${sha256}`,
      sha256,
      mediaType: "application/json",
      maxSizeBytes: 128,
      expiresAt: "2098-01-01T00:00:00.000Z"
    });
    const authorization = {
      hostId: host.id,
      runtimeLeaseId: "runtime-lease-a",
      grantId: transfer.grantId,
      sha256,
      sizeBytes: 64,
      mediaType: "application/json"
    };
    expect(grants.authorizeUpload(authorization)).toMatchObject({
      artifactRef: transfer.artifactRef
    });
    expect(grants.authorizeUpload(authorization)).toMatchObject({
      artifactRef: transfer.artifactRef
    });
    expect(() => grants.authorizeUpload({ ...authorization, sizeBytes: 65 })).toThrow(
      "runtime_artifact_grant_identity_conflict"
    );
    expect(() => grants.authorizeUpload({ ...authorization, hostId: "another-host" })).toThrow(
      "runtime_artifact_scope_forbidden"
    );
    deactivate();
    expect(() =>
      grants.acceptUpload(authorization, {
        ref: transfer.artifactRef,
        sha256,
        sizeBytes: authorization.sizeBytes,
        mediaType: authorization.mediaType
      })
    ).toThrow("runtime_artifact_scope_forbidden");
  });

  it("fails closed after release, detachment, or Server restart", async () => {
    const { grants, host, deactivate } = await setup();
    const sha256 = "e".repeat(64);
    const input = {
      runtimeLeaseId: "runtime-lease-a",
      operationId: "complete-operation-a",
      artifactRef: `artifact:sha256:${sha256}`,
      sha256,
      sizeBytes: 42,
      mediaType: "text/plain",
      expiresAt: "2098-01-01T00:00:00.000Z"
    };
    const transfer = grants.createDownloadGrant(input);
    const authorization = {
      hostId: host.id,
      runtimeLeaseId: input.runtimeLeaseId,
      grantId: transfer.grantId,
      sha256
    };
    expect(grants.authorizeDownload(authorization)).toMatchObject({ sizeBytes: 42 });
    deactivate();
    expect(() => grants.authorizeDownload(authorization)).toThrow(
      "runtime_artifact_scope_forbidden"
    );

    const activeAgain = await setup();
    const restartedTransfer = activeAgain.grants.createDownloadGrant(input);
    activeAgain.grants.revokeActiveAfterRestart();
    expect(() =>
      activeAgain.grants.authorizeDownload({
        ...authorization,
        hostId: activeAgain.host.id,
        grantId: restartedTransfer.grantId
      })
    ).toThrow("runtime_artifact_scope_forbidden");
  });
});
