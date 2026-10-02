import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANVAS_RUNTIME_CAPABILITY,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeCancelCommandSchema,
  serverEventSchema
} from "@planweave-ai/agent-host-protocol";
import { authoritativeContentVersionSchema } from "@planweave-ai/collaboration-protocol/content/version";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtime from "@planweave-ai/runtime";
import {
  captureAuthorizedCanvasContent,
  capturePackageSnapshot,
  readAuthorizedCanvasRuntimeStatus,
  readRuntimeResetReceipt,
  resetRuntimeState,
  type ProjectWorkspace
} from "@planweave-ai/runtime";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import type { CanvasRuntimeContentTransferPort } from "../runtime/canvasRuntimeContentTransfer.js";
import { FakeHostTransportClock } from "./support/hostTransportTestClock.js";
import { composeAgentHost } from "../composition/agentHostComposition.js";
import { CanvasRuntimeService } from "../runtime/canvasRuntimeService.js";
import { openAgentHostState } from "../state/agentHostState.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { deferred } from "./support/hostTransportSocketHarness.js";
import {
  artifactTransfer,
  directories,
  contentTarget,
  response,
  cancel as fixtureCancel,
  contentTransfer,
  delivery as fixtureDelivery,
  request as fixtureRequest,
  resolverWith,
  scope as fixtureScope,
  unusedWorkspace
} from "./support/canvasRuntimeServiceFixture.js";

const scope = canvasScopeRefSchema.parse(fixtureScope);
const request = (...args: Parameters<typeof fixtureRequest>) =>
  canvasRuntimeRequestCommandSchema.parse(fixtureRequest(...args));
const cancel = (...args: Parameters<typeof fixtureCancel>) =>
  canvasRuntimeCancelCommandSchema.parse(fixtureCancel(...args));
const delivery = (...args: Parameters<typeof fixtureDelivery>) =>
  serverEventSchema.parse(fixtureDelivery(...args));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(
  options: {
    workspace?: ProjectWorkspace;
    transfer?: CanvasRuntimeContentTransferPort;
    clock?: FakeHostTransportClock;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "planweave-canvas-shutdown-"));
  const state = await openAgentHostState(join(root, "host.sqlite"));
  const entered = deferred<void>();
  const release = deferred<void>();
  const service = new CanvasRuntimeService({
    resolver: resolverWith(async () => {
      entered.resolve();
      await release.promise;
      return {
        scope,
        project: options.workspace ?? unusedWorkspace(),
        canvas: options.workspace ?? unusedWorkspace()
      };
    }),
    receipts: state.canvasRuntime,
    capabilities: [CANVAS_RUNTIME_CAPABILITY],
    artifactTransfer,
    contentTransfer: options.transfer ?? contentTransfer
  });
  const client = new AgentHostClient({
    serverUrl: "http://127.0.0.1:1",
    hostId: "shutdown-host",
    token: "test-token",
    allowInsecureTransport: true,
    capabilities: [CANVAS_RUNTIME_CAPABILITY],
    capacity: 1,
    readiness: { workspaceMappings: [], acpProfiles: [], runtimeProjects: [] },
    state,
    canvasRuntime: service,
    executor: { execute: vi.fn() },
    clock: options.clock,
    limits: options.clock ? { shutdownTimeoutMs: 100 } : undefined,
    request: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
  });
  const close = vi.spyOn(state, "close");
  const closeResources = vi.fn();
  const composition = composeAgentHost({ state, transport: client, closeResources });
  cleanups.push(async () => {
    release.resolve();
    await client.stop().catch(() => undefined);
    if (close.mock.calls.length === 0) state.close();
    await rm(root, { recursive: true, force: true });
  });
  await composition.start();
  return { state, service, client, entered, release, close, closeResources, composition };
}

async function nextTurns() {
  for (let turn = 0; turn < 8; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Canvas recovery composition shutdown", () => {
  it("drains recovered pending work before closing SQLite or other resources", async () => {
    const f = await fixture();
    const failures: unknown[] = [];
    const handle = f.service.handle.bind(f.service);
    vi.spyOn(f.service, "handle").mockImplementation((command) => {
      const operation = handle(command);
      void operation.catch((error: unknown) => failures.push(error));
      return operation;
    });
    const command = request("pending-before-stop");
    f.state.receive(delivery(1, command));
    f.service.recover();
    await f.entered.promise;
    const shutdown = f.composition.shutdown();
    try {
      await nextTurns();
      expect(f.close).not.toHaveBeenCalled();
      expect(f.closeResources).not.toHaveBeenCalled();
    } finally {
      f.release.resolve();
      await shutdown;
      await nextTurns();
    }
    expect(f.close).toHaveBeenCalledOnce();
    expect(failures).toEqual([]);
  });

  it("leaves SQLite open when the transport cannot persist its drain", async () => {
    const f = await fixture();
    const failure = new Error("canvas_runtime_persistence_failed");
    const handle = f.service.handle.bind(f.service);
    vi.spyOn(f.service, "handle").mockImplementation((command) => {
      const operation = handle(command);
      void operation.catch(() => undefined);
      return operation;
    });
    vi.spyOn(f.state.canvasRuntime, "complete").mockImplementation(() => {
      throw failure;
    });
    f.state.receive(delivery(1, request("persist-failing-recovery")));
    void Promise.resolve(f.service.recover()).catch(() => undefined);
    await f.entered.promise;
    f.release.resolve();
    await nextTurns();
    await expect(f.composition.shutdown()).rejects.toThrow(
      "agent_host_composition_shutdown_failed"
    );
    expect(f.close).not.toHaveBeenCalled();
    expect(f.closeResources).not.toHaveBeenCalled();
  });

  it("rejects a bounded shutdown without closing state and drains the same work before restart", async () => {
    const clock = new FakeHostTransportClock();
    const f = await fixture({ clock });
    const command = request("timeout-recovery");
    f.state.receive(delivery(1, command));
    void f.service.recover();
    await f.entered.promise;
    const shutdown = f.composition.shutdown();
    const rejected = expect(shutdown).rejects.toThrow("agent_host_shutdown_requires_process_exit");
    await nextTurns();
    clock.advanceBy(100);
    await rejected;
    expect(f.close).not.toHaveBeenCalled();
    expect(f.closeResources).not.toHaveBeenCalled();
    expect(f.client.status().state).toBe("reconciliation-required");
    expect(() => f.client.start()).toThrow("canvas_runtime_shutdown_pending");
    f.release.resolve();
    await f.client.stop();
    expect(clock.pendingTimerCount()).toBe(0);
    f.client.start();
    expect(() => f.state.canvasRuntime.incomplete()).not.toThrow();
    await f.client.stop();
  });

  it("shares repeated stop and recovery without duplicating cancellation responses", async () => {
    const f = await fixture();
    const command = request("duplicate-recovery");
    f.state.receive(delivery(1, command));
    const complete = vi.spyOn(f.state.canvasRuntime, "complete");
    const first = f.service.recover();
    const second = f.service.recover();
    await f.entered.promise;
    const whileRunning = f.service.recover();
    const stopped = f.client.stop();
    expect(f.client.stop()).toBe(stopped);
    f.release.resolve();
    await Promise.all([first, second, whileRunning, stopped]);
    expect(complete).toHaveBeenCalledOnce();
    expect(response(f.state, command.requestId)).toMatchObject({
      response: {
        outcome: "error",
        error: { code: "request_cancelled" }
      }
    });
    f.client.start();
    const next = cancel("after-restart", "already-cancelled");
    f.state.receive(delivery(2, next));
    await f.service.handle(next);
    expect(response(f.state, next.requestId)).toMatchObject({ response: { outcome: "success" } });
    await f.composition.shutdown();
  });

  it("preserves a committed reset marker on cancellation and recovers it once after restart", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const snapshot = await capturePackageSnapshot({ projectRoot: workspace.init.workspace });
    const status = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: workspace.init.workspace,
      canvasId: scope.canvasId,
      expectedPackageDir: workspace.init.workspace.packageDir,
      scope
    });
    const evidence = {
      operationId: "shutdown-reset",
      sourceRevision: snapshot.snapshot.sourceRevision,
      graphFingerprint: status.packageFingerprint
    };
    const marker = { ...evidence, committedAt: "2026-10-02T00:00:00.000Z" };
    await resetRuntimeState({ projectRoot: workspace.init.workspace, receipt: marker });
    const f = await fixture({ workspace: workspace.init.workspace });
    const command = request(
      "interrupted-reset",
      { operation: "reset", runtimeLeaseId: "reset-lease", evidence, input: evidence },
      "2020-01-01T00:00:00.000Z"
    );
    f.state.receive(delivery(1, command));
    f.state.canvasRuntime.begin(command.requestId);
    const recovery = f.service.recover();
    await f.entered.promise;
    const stopped = f.client.stop();
    await nextTurns();
    expect(f.close).not.toHaveBeenCalled();
    f.release.resolve();
    await Promise.all([stopped, recovery]);
    expect(f.state.canvasRuntime.incomplete()).toMatchObject([{ status: "running" }]);
    expect(f.state.canvasRuntime.resetStatus(scope, evidence.operationId)).toMatchObject({
      kind: "pending"
    });
    expect(await readRuntimeResetReceipt({ projectRoot: workspace.init.workspace })).toEqual(
      marker
    );
    const complete = vi.spyOn(f.state.canvasRuntime, "complete");
    f.client.start();
    await Promise.all([f.service.recover(), f.service.recover()]);
    expect(complete).toHaveBeenCalledOnce();
    expect(response(f.state, command.requestId)).toMatchObject({
      response: { outcome: "success", result: { operationId: evidence.operationId } }
    });
    expect(await readRuntimeResetReceipt({ projectRoot: workspace.init.workspace })).toEqual(
      marker
    );
    await f.composition.shutdown();
  });

  it("waits for an admitted materialization commit before closing SQLite", async () => {
    const managed = await createTestWorkspace(basicManifest());
    const authority = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    directories.push(managed.home, managed.root, authority.home, authority.root);
    const captured = await captureAuthorizedCanvasContent({
      projectRoot: authority.init.workspace,
      authorityProjectId: scope.projectId
    });
    const status = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: authority.init.workspace,
      canvasId: scope.canvasId,
      expectedPackageDir: authority.init.workspace.packageDir,
      scope
    });
    const target = contentTarget(status.packageFingerprint);
    target.content.canonicalDigest = captured.content.canonicalDigest;
    target.content.versionId = `version-${captured.content.canonicalDigest}`;
    const fetched = deferred<void>();
    const transfer = {
      updateCredentialToken: vi.fn(),
      fetch: vi.fn(async () => {
        fetched.resolve();
        return authoritativeContentVersionSchema.parse({
          schemaVersion: "content-version/v1" as const,
          scope,
          content: captured.content,
          completed: target.content,
          createdAt: "2030-01-01T00:00:00.000Z",
          createdBy: { kind: "system" as const, id: "server" }
        });
      })
    };
    const f = await fixture({ workspace: managed.init.workspace, transfer });
    const admitted = deferred<void>();
    const releaseCommit = deferred<void>();
    const materialize = runtime.materializeAuthoritativeCanvasWorkspace;
    vi.spyOn(runtime, "materializeAuthoritativeCanvasWorkspace").mockImplementation(
      async (input) => {
        admitted.resolve();
        await releaseCommit.promise;
        return materialize(input);
      }
    );
    cleanups.push(async () => {
      releaseCommit.resolve();
    });
    const command = request("admitted-materialization", {
      operation: "availability",
      contentTarget: target
    });
    f.state.receive(delivery(1, command));
    const recovery = f.service.recover();
    f.release.resolve();
    await fetched.promise;
    await admitted.promise;
    const complete = vi.spyOn(f.state.canvasRuntime, "complete");
    const shutdown = f.composition.shutdown();
    try {
      await nextTurns();
      expect(f.close).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } finally {
      releaseCommit.resolve();
      await recovery;
      await shutdown;
    }
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[1]).toMatchObject({
      response: { outcome: "error", error: { code: "reconcile_required", reconcileRequired: true } }
    });
    const after = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: managed.init.workspace,
      canvasId: scope.canvasId,
      expectedPackageDir: managed.init.workspace.packageDir,
      scope
    });
    expect(after.packageFingerprint).toBe(status.packageFingerprint);
    expect(complete.mock.invocationCallOrder[0]).toBeLessThan(f.close.mock.invocationCallOrder[0]!);
    await nextTurns();
    expect(complete).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
});
