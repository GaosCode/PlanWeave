import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import { createRemoteBlockRuntimePort, type ProjectWorkspace } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import type {
  CanvasRuntimeResolverPort,
  ResolvedCanvasRuntime
} from "../runtime/canvasRuntimeResolver.js";
import { CanvasRuntimeService } from "../runtime/canvasRuntimeService.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";

const directories: string[] = [];
const states: AgentHostState[] = [];

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-canvas-runtime-service-"));
  directories.push(directory);
  const state = await openAgentHostState(join(directory, "state.sqlite"));
  states.push(state);
  return { state };
}

const scope = { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" };
const sourceRevision = `snapshot:${"b".repeat(64)}`;
const graphFingerprint = `pkg-${"a".repeat(64)}`;
const artifactTransfer = {
  updateCredentialToken: vi.fn(),
  synchronizeServerTime: vi.fn(),
  download: vi.fn(async () => new Uint8Array([1])),
  upload: vi.fn(async () => {})
};

function request(
  requestId: string,
  operation: Record<string, unknown> = { operation: "availability" },
  deadline = "2099-01-01T00:00:00.000Z"
) {
  return {
    type: "canvas_runtime.request" as const,
    protocolVersion: 1 as const,
    requestId,
    scope,
    deadline,
    operation
  };
}

function cancel(requestId: string, targetRequestId: string) {
  return {
    type: "canvas_runtime.cancel" as const,
    protocolVersion: 1 as const,
    requestId,
    targetRequestId,
    scope,
    deadline: "2099-01-01T00:00:00.000Z"
  };
}

function delivery(
  sequence: number,
  command: ReturnType<typeof request> | ReturnType<typeof cancel>
) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-${sequence}`,
    command
  };
}

function response(state: AgentHostState, requestId: string) {
  return state
    .pendingEvents()
    .find((event) => event.type === "canvas_runtime.response" && event.requestId === requestId);
}

function unusedWorkspace(): ProjectWorkspace {
  return {
    id: "project-1",
    kind: "managed",
    rootPath: "/not-observed",
    sourceRoot: null,
    planweaveHome: "/not-observed",
    workspaceRoot: "/not-observed",
    projectFile: "/not-observed/project.json",
    packageDir: "/not-observed/package",
    manifestFile: "/not-observed/manifest.json",
    stateFile: "/not-observed/state.json",
    resultsDir: "/not-observed/results",
    projectPromptFile: "/not-observed/project-prompt.md"
  };
}

function resolverWith(resolve: CanvasRuntimeResolverPort["resolve"]): CanvasRuntimeResolverPort {
  const workspace = unusedWorkspace();
  return {
    configured: () => true,
    mappings: () => [],
    resolveProject: async () => workspace,
    resolve
  };
}

function createLease(state: AgentHostState, runtimeLeaseId = "runtime-lease-1") {
  state.canvasRuntime.createLease({
    runtimeLeaseId,
    ...scope,
    sourceRevision,
    graphFingerprint,
    status: "active",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
}

describe("Canvas Runtime Host service", () => {
  it("dispatches bounded work facts without creating an execution lease", async () => {
    const { state } = await setup();
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const resolve = vi.fn(async () => ({
      scope,
      project: workspace.init.workspace,
      canvas: workspace.init.workspace
    }));
    const service = new CanvasRuntimeService({
      resolver: resolverWith(resolve),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer
    });
    const createRuntimeLease = vi.spyOn(state.canvasRuntime, "createLease");
    const command = request("request-work-facts", {
      operation: "resolve_work_items",
      input: {
        workItems: [
          { kind: "task", canvasId: scope.canvasId, taskId: "T-001" },
          { kind: "block", canvasId: scope.canvasId, blockRef: "T-001#B-001" }
        ]
      }
    });
    state.receive(delivery(1, command));
    await service.handle(command);

    expect(resolve).toHaveBeenCalledOnce();
    expect(response(state, command.requestId)).toMatchObject({
      response: {
        outcome: "success",
        operation: "resolve_work_items",
        result: {
          facts: [
            { kind: "task", taskId: "T-001", exists: true },
            { kind: "block", blockRef: "T-001#B-001", exists: true }
          ]
        }
      }
    });
    expect(createRuntimeLease).not.toHaveBeenCalled();
  });

  it("keeps package lease evidence separate from block mutation evidence", async () => {
    const { state } = await setup();
    const manifest = basicManifest();
    manifest.execution.defaultExecutor = "codex-acp";
    manifest.executors = {
      "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
    };
    const workspace = await createTestWorkspace(manifest);
    directories.push(workspace.home, workspace.root);
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({
        scope,
        project: workspace.init.workspace,
        canvas: workspace.init.workspace
      })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer
    });
    createLease(state);
    const candidate = await createRemoteBlockRuntimePort({
      projectRoot: workspace.init.workspace
    }).inspect({ ref: "T-001#B-001" });
    expect(candidate.sourceRevision).not.toBe(sourceRevision);
    const claim = request("request-block-evidence", {
      operation: "claim",
      runtimeLeaseId: "runtime-lease-1",
      evidence: {
        operationId: "operation-block-evidence",
        sourceRevision: candidate.sourceRevision,
        graphFingerprint: candidate.graphFingerprint
      },
      input: {
        ref: "T-001#B-001",
        operationId: "operation-block-evidence",
        controlPlane: "collaboration",
        sourceRevision: candidate.sourceRevision,
        graphFingerprint: candidate.graphFingerprint
      }
    });
    state.receive(delivery(1, claim));
    await service.handle(claim);
    expect(response(state, claim.requestId)).toMatchObject({
      response: { outcome: "success", operation: "claim" }
    });
  });

  it("fails closed when the capability was not negotiated or the deadline elapsed", async () => {
    const { state } = await setup();
    const resolve = vi.fn<CanvasRuntimeResolverPort["resolve"]>();
    const resolver = resolverWith(resolve);
    const capabilityRequest = request("request-capability");
    state.receive(delivery(1, capabilityRequest));
    await new CanvasRuntimeService({
      resolver,
      receipts: state.canvasRuntime,
      capabilities: [],
      artifactTransfer
    }).handle(capabilityRequest);
    expect(response(state, "request-capability")).toMatchObject({
      response: { outcome: "error", error: { code: "capability_not_negotiated" } }
    });

    const deadlineRequest = request(
      "request-deadline",
      { operation: "availability" },
      "2020-01-01T00:00:00.000Z"
    );
    state.receive(delivery(2, deadlineRequest));
    await new CanvasRuntimeService({
      resolver,
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer
    }).handle(deadlineRequest);
    expect(response(state, "request-deadline")).toMatchObject({
      response: { outcome: "error", error: { code: "deadline_exceeded" } }
    });

    const skewedRequest = request(
      "request-clock-skew",
      { operation: "availability" },
      "2026-01-01T00:05:00.000Z"
    );
    state.receive(delivery(3, skewedRequest));
    const skewedService = new CanvasRuntimeService({
      resolver,
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    skewedService.synchronizeServerTime(
      "2026-01-01T00:10:00.000Z",
      new Date("2026-01-01T00:00:00.000Z")
    );
    await skewedService.handle(skewedRequest);
    expect(response(state, "request-clock-skew")).toMatchObject({
      response: { outcome: "error", error: { code: "deadline_exceeded" } }
    });
    expect(artifactTransfer.synchronizeServerTime).toHaveBeenCalledWith(
      "2026-01-01T00:10:00.000Z",
      new Date("2026-01-01T00:00:00.000Z")
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("cancels uncommitted work without rewriting Runtime state", async () => {
    const { state } = await setup();
    let releaseResolve: ((value: ResolvedCanvasRuntime) => void) | undefined;
    const blocked = new Promise<ResolvedCanvasRuntime>((resolve) => {
      releaseResolve = resolve;
    });
    let calls = 0;
    const workspace = unusedWorkspace();
    const resolver = resolverWith(async () => {
      calls += 1;
      return calls === 1 ? blocked : { scope, project: workspace, canvas: workspace };
    });
    const service = new CanvasRuntimeService({
      resolver,
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer
    });
    const target = request("request-target");
    const cancellation = cancel("request-cancel", "request-target");
    state.receive(delivery(1, target));
    const targetRun = service.handle(target);
    await Promise.resolve();
    state.receive(delivery(2, cancellation));
    await service.handle(cancellation);
    releaseResolve?.({ scope, project: workspace, canvas: workspace });
    await targetRun;

    expect(response(state, "request-cancel")).toMatchObject({
      response: { outcome: "success", result: { cancelled: true } }
    });
    expect(response(state, "request-target")).toMatchObject({
      response: { outcome: "error", error: { code: "request_cancelled" } }
    });
  });

  it("aborts uncommitted work when the Host disconnects", async () => {
    const { state } = await setup();
    let releaseResolve: ((value: ResolvedCanvasRuntime) => void) | undefined;
    const blocked = new Promise<ResolvedCanvasRuntime>((resolve) => {
      releaseResolve = resolve;
    });
    const workspace = unusedWorkspace();
    const service = new CanvasRuntimeService({
      resolver: resolverWith(() => blocked),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer
    });
    const target = request("request-disconnect");
    state.receive(delivery(1, target));
    const run = service.handle(target);
    await Promise.resolve();
    service.disconnect();
    releaseResolve?.({ scope, project: workspace, canvas: workspace });
    await run;

    expect(response(state, target.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "request_cancelled" } }
    });
  });

  it("strictly parses Runtime inputs and keeps complete fail-closed without artifact bytes", async () => {
    const { state } = await setup();
    const workspace = unusedWorkspace();
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({ scope, project: workspace, canvas: workspace })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer
    });
    createLease(state);
    const inspect = request("request-invalid-inspect", {
      operation: "inspect",
      runtimeLeaseId: "runtime-lease-1",
      input: { unexpected: true }
    });
    state.receive(delivery(1, inspect));
    await service.handle(inspect);
    expect(response(state, inspect.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "invalid_operation_input" } }
    });

    const complete = request("request-complete-without-bytes", {
      operation: "complete",
      runtimeLeaseId: "runtime-lease-1",
      evidence: { operationId: "operation-1", sourceRevision, graphFingerprint },
      input: {
        ref: "T-001#B-001",
        operationId: "operation-1",
        controlPlane: "collaboration",
        sourceRevision,
        graphFingerprint,
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        reportArtifactRef: `artifact:sha256:${"c".repeat(64)}`
      }
    });
    state.receive(delivery(2, complete));
    await service.handle(complete);
    expect(response(state, complete.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "invalid_operation_input" } }
    });
  });

  it("releases leases idempotently and cancellation cannot replace a terminal response", async () => {
    const { state } = await setup();
    const workspace = unusedWorkspace();
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({ scope, project: workspace, canvas: workspace })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer
    });
    createLease(state);
    for (const [sequence, requestId] of [
      [1, "request-release-1"],
      [2, "request-release-2"]
    ] as const) {
      const release = request(requestId, {
        operation: "release",
        runtimeLeaseId: "runtime-lease-1"
      });
      state.receive(delivery(sequence, release));
      await service.handle(release);
      expect(response(state, requestId)).toMatchObject({
        response: { outcome: "success", result: { released: true } }
      });
    }

    const terminal = request("request-terminal");
    state.receive(delivery(3, terminal));
    state.canvasRuntime.begin(terminal.requestId);
    state.canvasRuntime.complete(terminal.requestId, {
      type: "canvas_runtime.response",
      protocolVersion: 1,
      requestId: terminal.requestId,
      response: {
        outcome: "error",
        operation: "availability",
        error: { code: "runtime_not_attached", message: "Unavailable.", retryable: false }
      }
    });
    const cancellation = cancel("request-cancel-terminal", terminal.requestId);
    state.receive(delivery(4, cancellation));
    await service.handle(cancellation);
    expect(response(state, cancellation.requestId)).toMatchObject({
      response: { outcome: "success", result: { cancelled: false } }
    });
    expect(response(state, terminal.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "runtime_not_attached" } }
    });
  });

  it("marks an in-flight request reconcile-required after Host restart", async () => {
    const { state } = await setup();
    const command = request("request-restart");
    state.receive(delivery(1, command));
    expect(state.canvasRuntime.begin(command.requestId)).toBe(true);
    new CanvasRuntimeService({
      resolver: resolverWith(async () => {
        throw new Error("must_not_resume_unknown_work");
      }),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer
    }).recover();
    expect(response(state, command.requestId)).toMatchObject({
      response: {
        outcome: "error",
        error: { code: "reconcile_required", reconcileRequired: true }
      }
    });
  });
});
