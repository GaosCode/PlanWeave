import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { executionEnvelopeSchema } from "@planweave-ai/agent-host-protocol";
import { afterEach } from "vitest";
import { handleAgentHostArtifactRequest } from "../../artifactHttp.js";
import { ArtifactStore } from "../../artifacts.js";
import { handleCanvasRuntimeArtifactRequest } from "../../canvas/runtimeArtifactHttp.js";
import { RuntimeArtifactGrantRepository } from "../../canvas/runtimeArtifactGrantRepository.js";
import { applyMigrations } from "../../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../../sqlite.js";
import { executionEnvelopeFor } from "../protocolTestFixtures.js";
import { createRemoteDispatchFixture } from "./remoteDispatchFixture.js";
import { createTestDispatchCoordination } from "./testDispatchCoordination.js";
import { loopbackHttpTransportAdmission } from "./transportAdmission.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        })
    )
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

export async function setupArtifactDownloadHttp(bytes: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "pw-artifact-download-http-"));
  directories.push(directory);
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const coordination = createTestDispatchCoordination(database, {
    leaseDurationMs: 60_000,
    hostOfflineAfterMs: 60_000,
    writeback: { complete: async () => {}, fail: async () => {} }
  });
  const registration = coordination.hosts.register("Native download host");
  coordination.hosts.reportOnline(registration.host.id, ["test"], 1);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifacts = new ArtifactStore(database, directory, bytes.length);
  const metadata = await artifacts.put({
    expectedSha256: sha256,
    expectedSizeBytes: bytes.length,
    mediaType: "text/plain",
    chunks: Readable.from([bytes])
  });
  const dispatch = createRemoteDispatchFixture(
    database,
    coordination,
    executionEnvelopeSchema.parse({
      ...executionEnvelopeFor("T-001#B-030", ["test"]),
      inputArtifacts: [
        { artifactRef: metadata.ref, logicalName: "download.txt", mediaType: "text/plain" }
      ]
    })
  );
  coordination.dispatches.accept(
    registration.host.id,
    "native-download-accept",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  let runtimeLeaseActive = true;
  const grants = new RuntimeArtifactGrantRepository(database, {
    maxArtifactBytes: bytes.length,
    leaseActive: () => runtimeLeaseActive
  });
  grants.recordLease({
    runtimeLeaseId: "native-download-lease",
    hostId: registration.host.id,
    workspaceId: dispatch.workspaceId,
    projectId: dispatch.projectId,
    canvasId: "default",
    attachmentVersion: 0,
    sourceRevision: `snapshot:${"b".repeat(64)}`,
    graphFingerprint: `pkg-${"a".repeat(64)}`,
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  const grantInput = {
    runtimeLeaseId: "native-download-lease",
    operationId: "native-download-operation",
    artifactRef: metadata.ref,
    sha256,
    sizeBytes: metadata.sizeBytes,
    mediaType: metadata.mediaType,
    expiresAt: "2098-01-01T00:00:00.000Z"
  };
  const runtimeGrant = grants.createDownloadGrant(grantInput);
  const handlerErrors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const admission = loopbackHttpTransportAdmission;
      if (
        await handleAgentHostArtifactRequest(request, response, {
          ...coordination,
          authorization: coordination.artifactAuthorization,
          artifacts,
          transportAdmission: admission
        })
      )
        return;
      if (
        await handleCanvasRuntimeArtifactRequest(request, response, {
          hosts: coordination.hosts,
          grants,
          artifacts,
          transportAdmission: admission
        })
      )
        return;
      response.writeHead(404).end();
    })().catch((error: unknown) => {
      handlerErrors.push(error);
      if (response.headersSent || response.destroyed) response.destroy();
      else response.writeHead(500).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("native_download_http_port_required");
  const origin = `http://127.0.0.1:${address.port}`;
  const hostPath = `${origin}/agent-hosts/${registration.host.id}`;
  return {
    server,
    artifacts,
    metadata,
    database,
    grants,
    grantInput,
    handlerErrors,
    artifactUrl: `${hostPath}/dispatches/${dispatch.id}/leases/${dispatch.leaseId}/attempts/${dispatch.executionAttemptId}/artifacts/${sha256}`,
    runtimeUrl: `${hostPath}/canvas-runtime/leases/native-download-lease/artifacts/${sha256}`,
    artifactHeaders: { Authorization: `Bearer ${registration.token}` },
    runtimeHeaders: {
      Authorization: `Bearer ${registration.token}`,
      "x-planweave-runtime-artifact-grant-id": runtimeGrant.grantId
    },
    deactivateRuntimeLease: () => {
      runtimeLeaseActive = false;
    }
  };
}
