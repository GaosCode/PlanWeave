import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAuthorizedCanvasContent } from "../../../runtime/src/desktop/authorizedCanvasContent.js";
import { readAuthorizedCanvasRuntimeStatus } from "../../../runtime/src/desktop/canvasRuntimeStatus.js";
import { buildResetCanvasRuntimeStatusProjection } from "../../../runtime/src/desktop/resetCanvasRuntimeStatus.js";
import { createRemoteBlockRuntimePort } from "../../../runtime/src/taskManager/remoteBlockRuntime.js";
import { resetRuntimeState } from "../../../runtime/src/runSessions/reset.js";
import { readState, writeState } from "../../../runtime/src/state.js";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { AuthoritativeExecutionRuntimeAdapter } from "../canvas/authoritativeExecutionRuntimeAdapter.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("Server reset and Host execution projection parity", () => {
  it.each([
    { legacy: false, mismatch: "none" },
    { legacy: true, mismatch: "none" },
    { legacy: true, mismatch: "stopped" },
    { legacy: false, mismatch: "status" }
  ])("validates Host reset before claim: $legacy / $mismatch", async ({ legacy, mismatch }) => {
    const manifest = basicManifest();
    manifest.execution.defaultExecutor = "codex-acp";
    manifest.executors = {
      "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
    };
    const fixture = await createTestWorkspace(manifest);
    directories.push(fixture.home, fixture.root);
    const workspace = fixture.init.workspace;
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    const readStatus = () =>
      readAuthorizedCanvasRuntimeStatus({
        projectRoot: workspace,
        canvasId: "default",
        expectedPackageDir: workspace.packageDir,
        scope
      });
    const content = await captureAuthorizedCanvasContent({ projectRoot: workspace });
    const initial = await readStatus();
    const baseline = buildResetCanvasRuntimeStatusProjection({
      content: content.content,
      scope,
      packageFingerprint: initial.packageFingerprint
    });
    if (legacy) baseline.blocks = baseline.blocks.map(({ stopped: _stopped, ...block }) => block);
    const runtime = createRemoteBlockRuntimePort({ projectRoot: workspace });
    const evidence = await runtime.inspect({ ref: "T-001#B-001" });
    const state = await readState(workspace.stateFile);
    state.blocks["T-001#B-001"] = { status: "blocked", blockedReason: "Stopped by the user" };
    await writeState(workspace.stateFile, state);
    const command = {
      operationId: "reset-before-run",
      expectedSourceRevision: evidence.sourceRevision,
      expectedGraphFingerprint: initial.packageFingerprint
    };
    const merge = vi.fn();
    const adapter = new AuthoritativeExecutionRuntimeAdapter({
      delegate: {
        acquire: async () => ({
          runtime,
          artifacts: { read: vi.fn() },
          readStatus,
          release: vi.fn(),
          reset: async () => {
            await resetRuntimeState({ projectRoot: workspace });
            const status = await readStatus();
            if (mismatch === "stopped") status.blocks[0].stopped = true;
            if (mismatch === "status") status.blocks[0].status = "blocked";
            return {
              operationId: command.operationId,
              sourceRevision: command.expectedSourceRevision,
              graphFingerprint: initial.packageFingerprint,
              status
            };
          }
        })
      },
      readContentAuthority: () => ({ packageFingerprint: initial.packageFingerprint, manifest }),
      resetBaselines: {
        latestAcceptedBaseline: () => ({ command, runtimeRevision: 1, status: baseline })
      },
      runtimeStatuses: {
        read: () => ({ runtimeRevision: 1, status: baseline }),
        mergeRemoteMutationFromExecution: merge
      }
    });

    if (mismatch !== "none") {
      await expect(adapter.acquire(scope)).rejects.toThrow(
        "canvas_runtime_reset_baseline_result_mismatch"
      );
      expect(merge).not.toHaveBeenCalled();
      return;
    }
    const lease = await adapter.acquire(scope);
    await expect(
      lease.runtime.claim({
        ref: "T-001#B-001",
        operationId: "run-after-reset",
        controlPlane: "owner",
        sourceRevision: evidence.sourceRevision,
        graphFingerprint: initial.packageFingerprint
      })
    ).resolves.toMatchObject({ ref: "T-001#B-001" });
    expect(merge).toHaveBeenCalledOnce();
  });
});
