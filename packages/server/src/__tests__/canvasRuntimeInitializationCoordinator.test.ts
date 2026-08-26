import { describe, expect, it, vi } from "vitest";
import type { RemoteBlockArtifactSource, RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  CanvasRuntimeInitializationCoordinator,
  persistCanvasRuntimeProjectionFromHostEvidence,
  projectCanvasRuntimeFromAcquiredLease
} from "../canvas/runtimeInitializationCoordinator.js";
import { CanvasRuntimeStatusRepository } from "../canvas/runtimeStatusRepository.js";
import type { CanvasExecutionRuntimeLeasePort } from "../canvas/executionRuntimePort.js";
import { readStableCanvasContentFingerprint } from "../canvas/contentFingerprint.js";
import { inWriteTransaction } from "../sqlite.js";
import {
  actor,
  canvasCommandServiceFixture as fixture
} from "./support/canvasCommandServiceFixture.js";

const scope = { workspaceId: "w", projectId: "p", canvasId: "default" } as const;
const sourceRevision = `snapshot:${"b".repeat(64)}`;
const unusedRuntime: RemoteBlockRuntimePort = {
  inspect: vi.fn(),
  claim: vi.fn(),
  activate: vi.fn(),
  query: vi.fn(),
  reconcile: vi.fn(),
  markInterrupted: vi.fn(),
  resumeAttempt: vi.fn(),
  retryAttempt: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn()
};
const unusedArtifacts: RemoteBlockArtifactSource = { read: vi.fn() };

async function setup(options: { activeLease?: boolean } = {}) {
  const context = await fixture();
  const fingerprint = readStableCanvasContentFingerprint(context.contentVersions, scope);
  const head = context.contentVersions.head(scope);
  if (!fingerprint || !head) throw new Error("test_content_authority_missing");
  const status = {
    schemaVersion: "canvas-runtime-status/v2" as const,
    scope,
    packageFingerprint: fingerprint,
    capturedAt: "2026-08-23T00:00:00.000Z",
    tasks: [],
    blocks: []
  };
  const readInitializationEvidence = vi.fn(async () => ({
    sourceRevision,
    graphFingerprint: fingerprint,
    status
  }));
  const reset = vi.fn();
  const acquire = vi.fn(async () => ({
    runtime: unusedRuntime,
    artifacts: unusedArtifacts,
    readInitializationEvidence,
    reset,
    release: vi.fn()
  }));
  const executionLeases: CanvasExecutionRuntimeLeasePort = { acquire };
  const runtimeStatuses = new CanvasRuntimeStatusRepository(context.database);
  const coordinator = new CanvasRuntimeInitializationCoordinator({
    access: context.access,
    workspaceIdentity: new WorkspaceIdentityRepository(context.database),
    contentVersions: context.contentVersions,
    runtimeStatuses,
    executionLeases,
    hasConflictingLease: () => options.activeLease ?? false,
    commitTransaction: (action) => inWriteTransaction(context.database, action)
  });
  const body = (operationId: string, overrides: Record<string, unknown> = {}) => ({
    operationId,
    expectedContentRevision: head.revision,
    expectedSourceRevision: sourceRevision,
    expectedGraphFingerprint: fingerprint,
    ...overrides
  });
  return {
    acquire,
    body,
    coordinator,
    database: context.database,
    fingerprint,
    readInitializationEvidence,
    reset,
    runtimeStatuses
  };
}

describe("CanvasRuntimeInitializationCoordinator", () => {
  it("creates the first Server projection by reading Host state without resetting it", async () => {
    const test = await setup();
    await expect(
      test.coordinator.initialize(actor("owner"), {
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        body: test.body("initialize-1")
      })
    ).resolves.toMatchObject({
      type: "canvas.runtime.initialize.accepted",
      runtimeRevision: 1,
      graphFingerprint: test.fingerprint
    });
    expect(test.readInitializationEvidence).toHaveBeenCalledOnce();
    expect(test.reset).not.toHaveBeenCalled();
    expect(test.runtimeStatuses.read(scope)).toMatchObject({ runtimeRevision: 1 });
  });

  it("is idempotent after revalidating Host evidence and never resets Host state", async () => {
    const test = await setup();
    const first = await test.coordinator.initialize(actor("owner"), {
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      body: test.body("initialize-first")
    });
    const second = await test.coordinator.initialize(actor("owner"), {
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      body: test.body("initialize-retry")
    });
    expect(first).toMatchObject({ runtimeRevision: 1 });
    expect(second).toMatchObject({ runtimeRevision: 1, operationId: "initialize-retry" });
    expect(test.acquire).toHaveBeenCalledTimes(2);
    expect(test.readInitializationEvidence).toHaveBeenCalledTimes(2);
    expect(test.reset).not.toHaveBeenCalled();
  });

  it("does not let an existing projection bypass Host source evidence validation", async () => {
    const test = await setup();
    await test.coordinator.initialize(actor("owner"), {
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      body: test.body("initialize-first")
    });

    await expect(
      test.coordinator.initialize(actor("owner"), {
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        body: test.body("initialize-stale-source", {
          expectedSourceRevision: `snapshot:${"c".repeat(64)}`
        })
      })
    ).resolves.toMatchObject({ code: "source_drift" });
    expect(test.runtimeStatuses.read(scope)).toMatchObject({ runtimeRevision: 1 });
    expect(test.reset).not.toHaveBeenCalled();
  });

  it("rejects active work and content drift before reading Host state", async () => {
    const leased = await setup({ activeLease: true });
    await expect(
      leased.coordinator.initialize(actor("owner"), {
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        body: leased.body("initialize-active")
      })
    ).resolves.toMatchObject({ code: "active_lease" });
    expect(leased.acquire).not.toHaveBeenCalled();

    const drifted = await setup();
    await expect(
      drifted.coordinator.initialize(actor("owner"), {
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        body: drifted.body("initialize-drift", { expectedContentRevision: 999 })
      })
    ).resolves.toMatchObject({ code: "source_drift" });
    expect(drifted.acquire).not.toHaveBeenCalled();
  });

  it("rejects Host source evidence drift without persisting a Runtime projection", async () => {
    const test = await setup();
    test.readInitializationEvidence.mockResolvedValueOnce({
      sourceRevision: `snapshot:${"c".repeat(64)}`,
      graphFingerprint: test.fingerprint,
      status: {
        schemaVersion: "canvas-runtime-status/v2",
        scope,
        packageFingerprint: test.fingerprint,
        capturedAt: "2026-08-23T00:00:00.000Z",
        tasks: [],
        blocks: []
      }
    });

    await expect(
      test.coordinator.initialize(actor("owner"), {
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        body: test.body("initialize-source-drift")
      })
    ).resolves.toMatchObject({ code: "source_drift" });
    expect(test.runtimeStatuses.read(scope)).toBeNull();
    expect(test.reset).not.toHaveBeenCalled();
  });

  it("shares the Host evidence persist writer for operation preparation", async () => {
    const test = await setup();
    const lease = await test.acquire();
    const first = await projectCanvasRuntimeFromAcquiredLease({
      runtimeStatuses: test.runtimeStatuses,
      commitTransaction: (action) => inWriteTransaction(test.database, action),
      scope,
      expectedGraphFingerprint: test.fingerprint,
      lease
    });
    expect(first).toMatchObject({ runtimeRevision: 1 });
    if (!first) throw new Error("expected_runtime_projection");
    const second = persistCanvasRuntimeProjectionFromHostEvidence({
      runtimeStatuses: test.runtimeStatuses,
      scope,
      expectedGraphFingerprint: test.fingerprint,
      status: first.status
    });
    expect(second).toMatchObject({ runtimeRevision: 1 });
    expect(test.reset).not.toHaveBeenCalled();
  });
});
