import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import {
  createRemoteBlockRuntimePort,
  captureAuthorizedCanvasContent,
  capturePackageSnapshot,
  readAuthorizedCanvasRuntimeStatus,
  readRuntimeResetReceipt,
  resetRuntimeState,
  type ProjectWorkspace
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ImportTransaction } from "../../../runtime/src/package/importTransaction.js";
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
const contentTransfer = {
  updateCredentialToken: vi.fn(),
  fetch: vi.fn(async () => {
    throw new Error("unexpected_content_transfer");
  })
};

function contentTarget(fingerprint = graphFingerprint) {
  const canonicalDigest = "c".repeat(64);
  return {
    revision: 1,
    content: {
      versionId: `version-${canonicalDigest}`,
      canonicalDigest,
      verification: "complete" as const
    },
    graphFingerprint: fingerprint
  };
}

function request(
  requestId: string,
  operation: Record<string, unknown> = { operation: "availability" },
  deadline = "2099-01-01T00:00:00.000Z"
) {
  const materializingOperation =
    operation.operation === "availability" ||
    operation.operation === "resolve_work_items" ||
    operation.operation === "acquire"
      ? { ...operation, contentTarget: operation.contentTarget ?? contentTarget() }
      : operation;
  return {
    type: "canvas_runtime.request" as const,
    protocolVersion: 1 as const,
    requestId,
    scope,
    deadline,
    operation: materializingOperation
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

async function writeContentTargetReceipt(
  workspace: ProjectWorkspace,
  target: ReturnType<typeof contentTarget>
): Promise<void> {
  await writeFile(
    join(workspace.workspaceRoot, "authority-content-target.json"),
    `${JSON.stringify(target, null, 2)}\n`,
    "utf8"
  );
}

describe("Canvas Runtime Host service", () => {
  it("materializes Server content only into the resolved managed canvas", async () => {
    const { state } = await setup();
    const source = await createTestWorkspace(basicManifest());
    const managed = await createTestWorkspace(basicManifest());
    const authority = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    directories.push(
      source.home,
      source.root,
      managed.home,
      managed.root,
      authority.home,
      authority.root
    );
    const sourceBefore = await capturePackageSnapshot({ projectRoot: source.init.workspace });
    const stateBefore = await readFile(managed.init.workspace.stateFile, "utf8");
    const preservedResult = join(managed.init.workspace.resultsDir, "preserved.txt");
    await writeFile(preservedResult, "preserved-result\n", "utf8");
    const captured = await captureAuthorizedCanvasContent({
      projectRoot: authority.init.workspace,
      authorityProjectId: scope.projectId
    });
    const authoritativeStatus = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: authority.init.workspace,
      canvasId: scope.canvasId,
      expectedPackageDir: authority.init.workspace.packageDir,
      scope
    });
    const target = contentTarget(authoritativeStatus.packageFingerprint);
    target.content.canonicalDigest = captured.content.canonicalDigest;
    target.content.versionId = `version-${captured.content.canonicalDigest}`;
    let transferContent = captured.content;
    let transferCompleted = target.content;
    let releaseFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let allowFetchToFinish: (() => void) | undefined;
    const fetchCanFinish = new Promise<void>((resolve) => {
      allowFetchToFinish = resolve;
    });
    const transfer = {
      updateCredentialToken: vi.fn(),
      fetch: vi.fn(async () => {
        releaseFetch?.();
        await fetchCanFinish;
        return {
          schemaVersion: "content-version/v1" as const,
          scope,
          content: transferContent,
          completed: transferCompleted,
          createdAt: "2030-01-01T00:00:00.000Z",
          createdBy: { kind: "system" as const, id: "server" }
        };
      })
    };
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({
        scope,
        project: source.init.workspace,
        canvas: managed.init.workspace
      })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer: transfer
    });
    const secondService = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({
        scope,
        project: source.init.workspace,
        canvas: managed.init.workspace
      })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer: transfer
    });
    const command = request("request-managed-materialization", {
      operation: "availability",
      contentTarget: target
    });
    const concurrent = request("request-managed-materialization-concurrent", {
      operation: "availability",
      contentTarget: target
    });
    state.receive(delivery(1, command));
    state.receive(delivery(2, concurrent));
    const first = service.handle(command);
    const second = secondService.handle(concurrent);
    await fetchStarted;
    expect(transfer.fetch).toHaveBeenCalledOnce();
    allowFetchToFinish?.();
    await Promise.all([first, second]);

    expect(response(state, command.requestId)).toMatchObject({
      response: {
        outcome: "success",
        operation: "availability",
        result: { graphFingerprint: authoritativeStatus.packageFingerprint }
      }
    });
    expect(response(state, concurrent.requestId)).toMatchObject({
      response: {
        outcome: "success",
        operation: "availability",
        result: { graphFingerprint: authoritativeStatus.packageFingerprint }
      }
    });
    expect(transfer.fetch).toHaveBeenCalledOnce();
    expect(await capturePackageSnapshot({ projectRoot: source.init.workspace })).toEqual(
      sourceBefore
    );
    expect(await readFile(managed.init.workspace.stateFile, "utf8")).toBe(stateBefore);
    expect(await readFile(preservedResult, "utf8")).toBe("preserved-result\n");
    await expect(
      readAuthorizedCanvasRuntimeStatus({
        projectRoot: managed.init.workspace,
        canvasId: scope.canvasId,
        expectedPackageDir: managed.init.workspace.packageDir,
        scope
      })
    ).resolves.toMatchObject({ packageFingerprint: authoritativeStatus.packageFingerprint });

    const authorityLayoutDirectory = join(authority.init.workspace.workspaceRoot, "desktop");
    await mkdir(authorityLayoutDirectory, { recursive: true });
    await writeFile(
      join(authorityLayoutDirectory, "layout.json"),
      `${JSON.stringify(
        {
          version: "desktop-layout/v1",
          projectId: authority.init.workspace.id,
          nodes: [],
          updatedAt: "2031-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const layoutOnlyUpdate = await captureAuthorizedCanvasContent({
      projectRoot: authority.init.workspace,
      authorityProjectId: scope.projectId
    });
    const layoutOnlyTarget = contentTarget(authoritativeStatus.packageFingerprint);
    layoutOnlyTarget.revision = 2;
    layoutOnlyTarget.content.canonicalDigest = layoutOnlyUpdate.content.canonicalDigest;
    layoutOnlyTarget.content.versionId = `version-${layoutOnlyUpdate.content.canonicalDigest}`;
    expect(layoutOnlyTarget.graphFingerprint).toBe(target.graphFingerprint);
    expect(layoutOnlyTarget.content.canonicalDigest).not.toBe(target.content.canonicalDigest);
    transferContent = layoutOnlyUpdate.content;
    transferCompleted = layoutOnlyTarget.content;
    const layoutOnlyCommand = request("request-managed-layout-only-materialization", {
      operation: "availability",
      contentTarget: layoutOnlyTarget
    });
    state.receive(delivery(3, layoutOnlyCommand));
    await service.handle(layoutOnlyCommand);

    expect(response(state, layoutOnlyCommand.requestId)).toMatchObject({
      response: { outcome: "success", operation: "availability" }
    });
    expect(transfer.fetch).toHaveBeenCalledTimes(2);
    await expect(
      readFile(join(managed.init.workspace.workspaceRoot, "desktop/layout.json"), "utf8")
    ).resolves.toContain("2031-01-01T00:00:00.000Z");
  });

  it("refuses to replace managed content while a live Runtime lease exists", async () => {
    const { state } = await setup();
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const transfer = {
      updateCredentialToken: vi.fn(),
      fetch: vi.fn(async () => {
        throw new Error("unexpected_content_transfer");
      })
    };
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({
        scope,
        project: workspace.init.workspace,
        canvas: workspace.init.workspace
      })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer: transfer
    });
    createLease(state);
    const command = request("request-materialization-with-live-lease", {
      operation: "availability",
      contentTarget: contentTarget(`pkg-${"d".repeat(64)}`)
    });
    state.receive(delivery(1, command));
    await service.handle(command);

    expect(response(state, command.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "content_out_of_sync" } }
    });
    expect(transfer.fetch).not.toHaveBeenCalled();
  });

  it("recovers an interrupted layout replacement before trusting a matching receipt", async () => {
    const { state } = await setup();
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const status = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: workspace.init.workspace,
      canvasId: scope.canvasId,
      expectedPackageDir: workspace.init.workspace.packageDir,
      scope
    });
    const target = contentTarget(status.packageFingerprint);
    await writeContentTargetReceipt(workspace.init.workspace, target);
    const layoutPath = join(workspace.init.workspace.workspaceRoot, "desktop", "layout.json");
    await mkdir(join(workspace.init.workspace.workspaceRoot, "desktop"), { recursive: true });
    await writeFile(
      layoutPath,
      `${JSON.stringify(
        {
          version: "desktop-layout/v1",
          projectId: workspace.init.workspace.id,
          nodes: [],
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const originalLayout = await readFile(layoutPath, "utf8");
    const interruptedLayout = join(
      workspace.init.workspace.workspaceRoot,
      "interrupted-layout.json"
    );
    await writeFile(interruptedLayout, originalLayout.replace("2026-01-01", "2039-01-01"), "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot: workspace.init.workspace.workspaceRoot,
      transactionId: "interrupted-layout-fast-path"
    });
    await transaction.replacePath(layoutPath, interruptedLayout);
    expect(await readFile(layoutPath, "utf8")).not.toBe(originalLayout);

    const transfer = {
      updateCredentialToken: vi.fn(),
      fetch: vi.fn(async () => {
        throw new Error("unexpected_content_transfer");
      })
    };
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({
        scope,
        project: workspace.init.workspace,
        canvas: workspace.init.workspace
      })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer: transfer
    });
    const command = request("request-recover-layout-fast-path", {
      operation: "availability",
      contentTarget: target
    });
    state.receive(delivery(1, command));
    await service.handle(command);

    expect(response(state, command.requestId)).toMatchObject({
      response: { outcome: "success", operation: "availability" }
    });
    expect(await readFile(layoutPath, "utf8")).toBe(originalLayout);
    expect(transfer.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed materialization targets before reading Runtime facts", async () => {
    const { state } = await setup();
    const resolve = vi.fn(async () => {
      const workspace = unusedWorkspace();
      return { scope, project: workspace, canvas: workspace };
    });
    const service = new CanvasRuntimeService({
      resolver: resolverWith(resolve),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    const command = request("request-malformed-content-target", {
      operation: "availability",
      contentTarget: { revision: "not-a-revision" }
    });
    state.receive(delivery(1, command));
    await service.handle(command);

    expect(response(state, command.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "invalid_operation_input" } }
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

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
      artifactTransfer,
      contentTransfer
    });
    const createRuntimeLease = vi.spyOn(state.canvasRuntime, "createLease");
    const status = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: workspace.init.workspace.rootPath,
      canvasId: scope.canvasId,
      expectedPackageDir: workspace.init.workspace.packageDir,
      scope
    });
    const command = request("request-work-facts", {
      operation: "resolve_work_items",
      contentTarget: contentTarget(status.packageFingerprint),
      input: {
        workItems: [
          { kind: "task", canvasId: scope.canvasId, taskId: "T-001" },
          { kind: "block", canvasId: scope.canvasId, blockRef: "T-001#B-001" }
        ]
      }
    });
    await writeContentTargetReceipt(
      workspace.init.workspace,
      contentTarget(status.packageFingerprint)
    );
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
      artifactTransfer,
      contentTransfer
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
      artifactTransfer,
      contentTransfer
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
      artifactTransfer,
      contentTransfer
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
      contentTransfer,
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
      artifactTransfer,
      contentTransfer
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
      artifactTransfer,
      contentTransfer
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
      artifactTransfer,
      contentTransfer
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
      artifactTransfer,
      contentTransfer
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
      artifactTransfer,
      contentTransfer
    }).recover();
    expect(response(state, command.requestId)).toMatchObject({
      response: {
        outcome: "error",
        error: { code: "reconcile_required", reconcileRequired: true }
      }
    });
  });

  it("resets Runtime state and rereads the empty-state projection", async () => {
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
      artifactTransfer,
      contentTransfer
    });
    const beforeReset = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: workspace.init.workspace.rootPath,
      canvasId: scope.canvasId,
      expectedPackageDir: workspace.init.workspace.packageDir,
      scope
    });
    const availabilityRequest = request("request-reset-availability", {
      operation: "availability",
      contentTarget: contentTarget(beforeReset.packageFingerprint)
    });
    await writeContentTargetReceipt(
      workspace.init.workspace,
      contentTarget(beforeReset.packageFingerprint)
    );
    state.receive(delivery(1, availabilityRequest));
    await service.handle(availabilityRequest);
    const available = response(state, availabilityRequest.requestId);
    expect(available).toMatchObject({
      response: { outcome: "success", operation: "availability" }
    });
    if (available?.type !== "canvas_runtime.response" || available.response.outcome !== "success") {
      throw new Error("reset_availability_required");
    }
    if (available.response.operation !== "availability") {
      throw new Error("reset_availability_required");
    }
    if (available.response.result.kind !== "available") {
      throw new Error("reset_availability_required");
    }
    const runtime = createRemoteBlockRuntimePort({ projectRoot: workspace.init.workspace });
    const candidate = await runtime.inspect({ ref: "T-001#B-001" });
    await runtime.claim({
      ref: "T-001#B-001",
      operationId: "operation-before-reset",
      controlPlane: "collaboration",
      sourceRevision: candidate.sourceRevision,
      graphFingerprint: candidate.graphFingerprint
    });
    const evidence = {
      operationId: "operation-reset-1",
      sourceRevision: available.response.result.sourceRevision,
      graphFingerprint: available.response.result.graphFingerprint
    };
    state.canvasRuntime.createLease({
      runtimeLeaseId: "runtime-lease-reset",
      ...scope,
      sourceRevision: evidence.sourceRevision,
      graphFingerprint: evidence.graphFingerprint,
      status: "active",
      acquiredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const reset = request("request-reset", {
      operation: "reset",
      runtimeLeaseId: "runtime-lease-reset",
      evidence,
      input: {
        operationId: evidence.operationId,
        sourceRevision: evidence.sourceRevision,
        graphFingerprint: evidence.graphFingerprint,
        reason: "Host reset requested."
      }
    });
    state.receive(delivery(2, reset));
    await service.handle(reset);
    expect(response(state, reset.requestId)).toMatchObject({
      response: {
        outcome: "success",
        operation: "reset",
        result: {
          operationId: evidence.operationId,
          sourceRevision: evidence.sourceRevision,
          graphFingerprint: evidence.graphFingerprint
        }
      }
    });
    const resetResponse = response(state, reset.requestId);
    if (
      resetResponse?.type !== "canvas_runtime.response" ||
      resetResponse.response.outcome !== "success" ||
      resetResponse.response.operation !== "reset"
    ) {
      throw new Error("reset_success_required");
    }
    expect(resetResponse.response.result.status).toMatchObject({
      packageFingerprint: evidence.graphFingerprint,
      scope,
      blocks: expect.arrayContaining([
        expect.objectContaining({ ref: "T-001#B-001", status: "ready" })
      ])
    });
    const statusQuery = request("request-reset-status", {
      operation: "reset_status",
      operationId: evidence.operationId
    });
    state.receive(delivery(3, statusQuery));
    await new CanvasRuntimeService({
      resolver: resolverWith(async () => {
        throw new Error("durable_result_must_not_resolve_runtime_path");
      }),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    }).handle(statusQuery);
    expect(response(state, statusQuery.requestId)).toMatchObject({
      response: {
        outcome: "success",
        operation: "reset_status",
        result: {
          kind: "succeeded",
          result: { operationId: evidence.operationId }
        }
      }
    });
  });

  it("recovers a reset committed to Runtime before its success receipt after Host restart", async () => {
    const { state } = await setup();
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const resolver = resolverWith(async () => ({
      scope,
      project: workspace.init.workspace,
      canvas: workspace.init.workspace
    }));
    const initialService = new CanvasRuntimeService({
      resolver,
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    const beforeRecovery = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: workspace.init.workspace.rootPath,
      canvasId: scope.canvasId,
      expectedPackageDir: workspace.init.workspace.packageDir,
      scope
    });
    const availabilityRequest = request("request-recovery-availability", {
      operation: "availability",
      contentTarget: contentTarget(beforeRecovery.packageFingerprint)
    });
    await writeContentTargetReceipt(
      workspace.init.workspace,
      contentTarget(beforeRecovery.packageFingerprint)
    );
    state.receive(delivery(1, availabilityRequest));
    await initialService.handle(availabilityRequest);
    const available = response(state, availabilityRequest.requestId);
    if (
      available?.type !== "canvas_runtime.response" ||
      available.response.outcome !== "success" ||
      available.response.operation !== "availability" ||
      available.response.result.kind !== "available"
    ) {
      throw new Error("reset_recovery_availability_required");
    }
    const evidence = {
      operationId: "operation-reset-recovery",
      sourceRevision: available.response.result.sourceRevision,
      graphFingerprint: available.response.result.graphFingerprint
    };
    state.canvasRuntime.createLease({
      runtimeLeaseId: "runtime-lease-reset-recovery-active",
      ...scope,
      sourceRevision: evidence.sourceRevision,
      graphFingerprint: evidence.graphFingerprint,
      status: "active",
      acquiredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const reset = request("request-reset-recovery", {
      operation: "reset",
      runtimeLeaseId: "runtime-lease-reset-recovery-active",
      evidence,
      input: {
        operationId: evidence.operationId,
        sourceRevision: evidence.sourceRevision,
        graphFingerprint: evidence.graphFingerprint
      }
    });
    state.receive(delivery(2, reset));
    expect(state.canvasRuntime.begin(reset.requestId)).toBe(true);
    const committedAt = "2026-08-22T12:00:00.000Z";
    await resetRuntimeState({
      projectRoot: workspace.init.workspace,
      receipt: { ...evidence, committedAt }
    });

    new CanvasRuntimeService({
      resolver,
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    }).recover();
    await vi.waitFor(() =>
      expect(response(state, reset.requestId)).toMatchObject({
        response: {
          outcome: "success",
          operation: "reset",
          result: { operationId: evidence.operationId }
        }
      })
    );
    await expect(
      readRuntimeResetReceipt({ projectRoot: workspace.init.workspace })
    ).resolves.toEqual({ ...evidence, committedAt });
    expect(state.canvasRuntime.resetStatus(scope, evidence.operationId)).toMatchObject({
      kind: "succeeded",
      result: { operationId: evidence.operationId }
    });
  });

  it("rejects reset when source evidence drifted", async () => {
    const { state } = await setup();
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => ({
        scope,
        project: workspace.init.workspace,
        canvas: workspace.init.workspace
      })),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    createLease(state, "runtime-lease-drift");
    const reset = request("request-reset-drift", {
      operation: "reset",
      runtimeLeaseId: "runtime-lease-drift",
      evidence: {
        operationId: "operation-reset-drift",
        sourceRevision,
        graphFingerprint
      },
      input: {
        operationId: "operation-reset-drift",
        sourceRevision,
        graphFingerprint
      }
    });
    state.receive(delivery(1, reset));
    await service.handle(reset);
    expect(response(state, reset.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "content_out_of_sync" } }
    });
  });
});
