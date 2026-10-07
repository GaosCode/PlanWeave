import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import {
  AuthoritativeCanvasWorkspaceConflictError,
  captureAuthorizedCanvasContent,
  capturePackageSnapshot,
  readAuthorizedCanvasRuntimeStatus
} from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ImportTransaction } from "../../../runtime/src/package/importTransaction.js";
import { CanvasRuntimeService } from "../runtime/canvasRuntimeService.js";

import {
  directories,
  setup,
  scope,
  artifactTransfer,
  contentTransfer,
  contentTarget,
  request,
  delivery,
  response,
  unusedWorkspace,
  resolverWith,
  createLease,
  writeContentTargetReceipt
} from "./support/canvasRuntimeServiceFixture.js";

describe("Canvas Runtime Host Materialization", () => {
  it.each([
    [new AuthoritativeCanvasWorkspaceConflictError(), "content_out_of_sync"],
    [new Error("Unknown recovery failure."), "canvas_runtime_operation_failed"],
    [new SyntaxError("Unexpected token in recovery JSON"), "canvas_runtime_operation_failed"],
    [
      Object.assign(new Error("Permission denied."), { code: "EACCES" }),
      "canvas_runtime_operation_failed"
    ]
  ])("maps only the typed authority conflict through the actual Host response: %s", async (failure, code) => {
    const { state } = await setup();
    const service = new CanvasRuntimeService({
      resolver: resolverWith(async () => {
        throw failure;
      }),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    const command = request("request-authority-recovery-error", { operation: "availability" });
    state.receive(delivery(1, command));
    await service.handle(command);
    expect(response(state, command.requestId)).toMatchObject({
      response: { outcome: "error", error: { code } }
    });
  });

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

    const restartedHostResolver = vi.fn(async () => ({
      scope,
      project: source.init.workspace,
      canvas: managed.init.workspace
    }));
    const restartedHost = new CanvasRuntimeService({
      resolver: resolverWith(restartedHostResolver),
      receipts: state.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer: transfer
    });
    await restartedHost.handle(command);

    expect(restartedHostResolver).not.toHaveBeenCalled();
    expect(transfer.fetch).toHaveBeenCalledOnce();

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

  it("reads canvas availability once per already-materialized request", async () => {
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
    const runtime = await import("@planweave-ai/runtime");
    const snapshotSpy = vi.spyOn(runtime, "capturePackageSnapshot");
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
    const command = request("request-availability-once", {
      operation: "availability",
      contentTarget: target
    });
    state.receive(delivery(1, command));
    await service.handle(command);

    expect(response(state, command.requestId)).toMatchObject({
      response: { outcome: "success", operation: "availability" }
    });
    expect(snapshotSpy).toHaveBeenCalledOnce();
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
});
