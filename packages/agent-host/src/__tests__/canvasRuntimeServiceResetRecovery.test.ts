import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import {
  createRemoteBlockRuntimePort,
  readAuthorizedCanvasRuntimeStatus,
  readRuntimeResetReceipt,
  resetRuntimeState
} from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { CanvasRuntimeService } from "../runtime/canvasRuntimeService.js";

import {
  directories,
  setup,
  scope,
  sourceRevision,
  graphFingerprint,
  artifactTransfer,
  contentTransfer,
  contentTarget,
  request,
  delivery,
  response,
  resolverWith,
  createLease,
  writeContentTargetReceipt
} from "./support/canvasRuntimeServiceFixture.js";

describe("Canvas Runtime Host ResetRecovery", () => {
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
    const reset = request(
      "request-reset-recovery",
      {
        operation: "reset",
        runtimeLeaseId: "runtime-lease-reset-recovery-active",
        evidence,
        input: {
          operationId: evidence.operationId,
          sourceRevision: evidence.sourceRevision,
          graphFingerprint: evidence.graphFingerprint
        }
      },
      "2020-01-01T00:00:00.000Z"
    );
    state.receive(delivery(2, reset));
    expect(state.canvasRuntime.begin(reset.requestId)).toBe(true);
    const committedAt = "2026-08-22T12:00:00.000Z";
    await resetRuntimeState({
      projectRoot: workspace.init.workspace,
      receipt: { ...evidence, committedAt }
    });

    await new CanvasRuntimeService({
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
