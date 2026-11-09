import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { parseServerConfig } from "../../../server/src/config.js";
import { RuntimeArtifactGrantRepository } from "../../../server/src/canvas/runtimeArtifactGrantRepository.js";
import { RuntimeArtifactRetention } from "../../../server/src/canvas/runtimeArtifactRetention.js";
import { ArtifactStore } from "../../../server/src/artifacts.js";
import { createDistributedServerComposition } from "../../../server/src/serverComposition.js";
import { openServerDatabase } from "../../../server/src/sqlite.js";
import { scope, setup, storeReport } from "./support/canvasRuntimeArtifactLoopbackFixture.js";

it("collects real Host RPC and HTTP history after a Server restart without reviving old grants", async () => {
  const fixture = await setup();
  const bytes = Buffer.from("retention round trip payload\n");
  const artifact = await storeReport(fixture.artifacts, bytes);
  const counts = () => ({
    leases: Number(
      fixture.server.database.prepare("SELECT COUNT(*) n FROM canvas_runtime_leases").get()!.n
    ),
    grants: Number(
      fixture.server.database
        .prepare("SELECT COUNT(*) n FROM canvas_runtime_artifact_grants")
        .get()!.n
    )
  });
  let oldUrl = "";
  let oldGrantId = "";
  let oldLease: ReturnType<typeof fixture.grants.lease>;
  for (let index = 0; index < 121; index++) {
    const acquired = await fixture.adapter.acquire(scope);
    const row = fixture.server.database
      .prepare("SELECT runtime_lease_id FROM canvas_runtime_leases ORDER BY rowid DESC LIMIT 1")
      .get()!;
    const lease = fixture.grants.lease(String(row.runtime_lease_id))!;
    const input = {
      runtimeLeaseId: lease.runtimeLeaseId,
      operationId: `retention-${index}`,
      artifactRef: artifact.ref,
      sha256: artifact.sha256,
      mediaType: artifact.mediaType,
      expiresAt: lease.expiresAt
    };
    const download = fixture.grants.createDownloadGrant({ ...input, sizeBytes: bytes.length });
    const upload = fixture.grants.createUploadGrant({ ...input, maxSizeBytes: 1024 });
    if (index === 0 || index === 120) {
      expect(
        Buffer.from(await fixture.transfer.download(download, new AbortController().signal))
      ).toEqual(bytes);
      await fixture.transfer.upload(
        upload,
        bytes,
        artifact.mediaType,
        new AbortController().signal
      );
      expect(await fixture.artifacts.read(artifact.ref)).toEqual(bytes);
    }
    if (index === 0) {
      oldLease = lease;
      oldGrantId = download.grantId;
      oldUrl = `/agent-hosts/${fixture.hostRegistration.host.id}/canvas-runtime/leases/${lease.runtimeLeaseId}/artifacts/${artifact.sha256}`;
    }
    if (index < 120) await acquired.release();
    if (index === 59) await fixture.restartHost();
  }
  expect(counts()).toEqual({ leases: 121, grants: 242 });
  const headers = {
    Authorization: `Bearer ${fixture.hostRegistration.token}`,
    "x-planweave-runtime-artifact-grant-id": oldGrantId
  };
  const released = await fetch(`${fixture.origin}${oldUrl}`, { headers });
  expect(released.status).toBe(403);
  await released.body?.cancel();
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: fixture.server.config.dataDirectory,
    trustedProjects: [],
    operatorCredentials: [
      {
        operatorId: "retention-test",
        tokenSha256: "a".repeat(64),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  await fixture.stop();
  let now = new Date();
  const callbacks: Array<() => void> = [];
  const originalTimeout = globalThis.setTimeout;
  const schedule = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) => {
      const timer = originalTimeout(callback, delay, ...args);
      if (delay === 60_000 && typeof callback === "function")
        callbacks.push(() => {
          clearTimeout(timer);
          callback(...args);
        });
      return timer;
    });
  const httpServer = createServer();
  const composition = await createDistributedServerComposition({
    httpServer,
    config,
    clock: () => now
  });
  const database = await openServerDatabase(config.databasePath, 5000);
  try {
    const count = () => ({
      leases: Number(database.prepare("SELECT COUNT(*) n FROM canvas_runtime_leases").get()!.n),
      grants: Number(
        database.prepare("SELECT COUNT(*) n FROM canvas_runtime_artifact_grants").get()!.n
      )
    });
    expect(count()).toEqual({ leases: 121, grants: 242 });
    expect(
      database.prepare("SELECT COUNT(*) n FROM canvas_runtime_leases WHERE status='active'").get()!
        .n
    ).toBe(0);
    now = new Date(now.getTime() + 2 * 24 * 60 * 60_000);
    const progress: Array<ReturnType<typeof count>> = [count()];
    for (let pass = 0; pass < 12 && count().leases > 0; pass++) {
      const callback = callbacks.shift();
      expect(callback).toBeDefined();
      callback!();
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      progress.push(count());
      expect(progress[pass]!.leases - progress[pass + 1]!.leases).toBeLessThanOrEqual(100);
      expect(progress[pass]!.grants - progress[pass + 1]!.grants).toBeLessThanOrEqual(200);
    }
    expect(count()).toEqual({ leases: 0, grants: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      await new ArtifactStore(database, config.dataDirectory, 1024 * 1024).read(artifact.ref)
    ).toEqual(bytes);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("test_http_address_missing");
    const denied = await fetch(`http://127.0.0.1:${address.port}${oldUrl}`, { headers });
    expect(denied.status).toBe(403);
    await denied.body?.cancel();
    expect(() =>
      new RuntimeArtifactGrantRepository(database, {
        maxArtifactBytes: 1024,
        clock: () => now,
        leaseActive: () => false
      }).recordLease(oldLease!)
    ).toThrow("runtime_artifact_scope_forbidden");
    expect(count()).toEqual({ leases: 0, grants: 0 });
    process.stdout.write(
      `${JSON.stringify({
        retentionLoopback: {
          progress,
          payloadBytes: bytes.length,
          releasedStatus: released.status,
          collectedStatus: denied.status
        }
      })}\n`
    );
  } finally {
    schedule.mockRestore();
    await composition.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    database.close();
  }
});

it("finalizes a real HTTP upload while new grants and maintenance interleave", async () => {
  let now = new Date();
  const fixture = await setup({ clock: () => now });
  const bytes = Buffer.from("concurrent finalization payload\n");
  const artifact = await storeReport(fixture.artifacts, bytes);
  const acquired = await fixture.adapter.acquire(scope);
  const row = fixture.server.database
    .prepare("SELECT runtime_lease_id FROM canvas_runtime_leases")
    .get()!;
  const lease = fixture.grants.lease(String(row.runtime_lease_id))!;
  const input = {
    runtimeLeaseId: lease.runtimeLeaseId,
    operationId: "interleaved-upload",
    artifactRef: artifact.ref,
    sha256: artifact.sha256,
    mediaType: artifact.mediaType,
    expiresAt: lease.expiresAt
  };
  const upload = fixture.grants.createUploadGrant({ ...input, maxSizeBytes: 1024 });
  let entered!: () => void;
  let proceed!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const put = fixture.artifacts.put.bind(fixture.artifacts);
  const pendingPut = vi.spyOn(fixture.artifacts, "put").mockImplementationOnce(async (value) => {
    entered();
    await barrier;
    return put(value);
  });
  const uploading = fixture.transfer.upload(
    upload,
    bytes,
    artifact.mediaType,
    new AbortController().signal
  );
  try {
    await started;
    const download = fixture.grants.createDownloadGrant({ ...input, sizeBytes: bytes.length });
    const retention = new RuntimeArtifactRetention(
      fixture.server.database,
      fixture.grants,
      () => now
    );
    expect(retention.compactBatch()).toMatchObject({ selected: 0, grantsDeleted: 0 });
    expect(fixture.grants.createDownloadGrant({ ...input, sizeBytes: bytes.length })).toEqual(
      download
    );
    expect(() =>
      fixture.grants.createDownloadGrant({ ...input, sizeBytes: bytes.length + 1 })
    ).toThrow("runtime_artifact_grant_identity_conflict");
    proceed();
    await uploading;
    expect(
      fixture.server.database
        .prepare("SELECT consumed_at FROM canvas_runtime_artifact_grants WHERE grant_id=?")
        .get(upload.grantId)!.consumed_at
    ).not.toBeNull();
    expect(
      Buffer.from(await fixture.transfer.download(download, new AbortController().signal))
    ).toEqual(bytes);
    await acquired.release();
    now = new Date(now.getTime() + 2 * 24 * 60 * 60_000);
    expect(retention.compactBatch()).toEqual({
      selected: 1,
      compacted: 1,
      skipped: 0,
      grantsDeleted: 2
    });
    expect(await fixture.artifacts.read(artifact.ref)).toEqual(bytes);
  } finally {
    proceed();
    await uploading;
    pendingPut.mockRestore();
  }
});
