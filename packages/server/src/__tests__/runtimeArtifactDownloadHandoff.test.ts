import { createHash } from "node:crypto";
import type { ReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../artifacts.js";
import { handleCanvasRuntimeArtifactRequest } from "../canvas/runtimeArtifactHttp.js";
import { RuntimeArtifactGrantRepository } from "../canvas/runtimeArtifactGrantRepository.js";
import { AgentHostRepository } from "../hosts.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];
const sources: ReadStream[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const source of sources.splice(0)) {
    source.destroy();
    if (!source.closed) await new Promise<void>((resolve) => source.once("close", resolve));
  }
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "pw-download-handoff-"));
  directories.push(directory);
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const hosts = new AgentHostRepository(database);
  const host = hosts.register("Download host");
  const artifacts = new ArtifactStore(database, directory, 1_024);
  const bytes = Buffer.from("handoff bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const metadata = await artifacts.put({
    expectedSha256: sha256,
    expectedSizeBytes: bytes.length,
    mediaType: "text/plain",
    chunks: ReadableBytes(bytes)
  });
  const grants = new RuntimeArtifactGrantRepository(database, {
    maxArtifactBytes: 1_024,
    leaseActive: () => true
  });
  grants.recordLease({
    runtimeLeaseId: "download-lease",
    hostId: host.host.id,
    workspaceId: "workspace-a",
    projectId: "project-a",
    canvasId: "default",
    attachmentVersion: 0,
    sourceRevision: `snapshot:${"b".repeat(64)}`,
    graphFingerprint: `pkg-${"a".repeat(64)}`,
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  const grant = grants.createDownloadGrant({
    runtimeLeaseId: "download-lease",
    operationId: "download-operation",
    artifactRef: metadata.ref,
    sha256,
    sizeBytes: metadata.sizeBytes,
    mediaType: metadata.mediaType,
    expiresAt: "2098-01-01T00:00:00.000Z"
  });
  const socket = new Socket();
  sockets.push(socket);
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  const request = new IncomingMessage(socket);
  request.method = "GET";
  request.url = `/agent-hosts/${host.host.id}/canvas-runtime/leases/download-lease/artifacts/${sha256}`;
  request.headers = {
    authorization: `Bearer ${host.token}`,
    "x-planweave-runtime-artifact-grant-id": grant.grantId
  };
  const response = new ServerResponse(request);
  const openRead = artifacts.openRead.bind(artifacts);
  const opened = await openRead(metadata.ref);
  sources.push(opened.stream);
  vi.spyOn(artifacts, "openRead").mockResolvedValue(opened);
  return {
    request,
    response,
    opened,
    artifacts,
    options: { hosts, artifacts, grants, transportAdmission: loopbackHttpTransportAdmission }
  };
}

async function* ReadableBytes(bytes: Buffer) {
  yield bytes;
}

describe("runtime artifact opened-source ownership", () => {
  it("reclaims a native file source when the granted metadata mismatches", async () => {
    const test = await setup();
    test.opened.metadata = { ...test.opened.metadata, mediaType: "application/json" };
    await handleCanvasRuntimeArtifactRequest(test.request, test.response, test.options);
    expect(test.response.statusCode).toBe(409);
    expect(test.opened.stream.destroyed).toBe(true);
  });

  it("reclaims a native file source if writing headers throws", async () => {
    const test = await setup();
    vi.spyOn(test.response, "writeHead").mockImplementationOnce(() => {
      throw new Error("bad header");
    });
    await handleCanvasRuntimeArtifactRequest(test.request, test.response, test.options);
    expect(test.response.statusCode).toBe(500);
    expect(test.opened.stream.destroyed).toBe(true);
  });

  it("terminates a response if a header failure occurs after headers were committed", async () => {
    const test = await setup();
    const writeHead = test.response.writeHead.bind(test.response);
    vi.spyOn(test.response, "writeHead").mockImplementationOnce(() => {
      writeHead(200);
      throw new Error("header setup failed after commit");
    });
    await handleCanvasRuntimeArtifactRequest(test.request, test.response, test.options);
    expect(test.response.statusCode).toBe(200);
    expect(test.response.headersSent).toBe(true);
    expect(test.response.destroyed).toBe(true);
    expect(test.opened.stream.destroyed).toBe(true);
  });

  it("reclaims a native file opened while the response has already closed", async () => {
    const test = await setup();
    test.response.destroy();
    await handleCanvasRuntimeArtifactRequest(test.request, test.response, test.options);
    expect(test.opened.stream.destroyed).toBe(true);
    expect(test.response.headersSent).toBe(false);
  });

  it("reclaims a native file on the response close event after handoff", async () => {
    const test = await setup();
    await handleCanvasRuntimeArtifactRequest(test.request, test.response, test.options);
    test.response.emit("close");
    expect(test.opened.stream.destroyed).toBe(true);
    await setImmediate();
  });
});
