import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteBlockRuntimePort } from "../taskManager/remoteBlockRuntime.js";
import { projectRemoteBlockExecution } from "../taskManager/remoteExecutionReadModel.js";
import { readState } from "../state.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function stoppedFixture() {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  const workspace = await createTestWorkspace(manifest);
  directories.push(workspace.home, workspace.root);
  const runtime = createRemoteBlockRuntimePort({ projectRoot: workspace.root });
  const candidate = await runtime.inspect({ ref: "T-001#B-001" });
  const claim = {
    ref: candidate.blockRef,
    operationId: "original-operation",
    controlPlane: "collaboration" as const,
    sourceRevision: candidate.sourceRevision,
    graphFingerprint: candidate.graphFingerprint
  };
  const original = {
    ...claim,
    dispatchId: "original-dispatch",
    executionAttemptId: "original-attempt"
  };
  await runtime.claim(claim);
  await runtime.activate(original);
  await runtime.fail({
    ...original,
    failure: { code: "execution_cancelled", message: "Stopped by user.", retryable: false }
  });
  const restoration = {
    operationId: original.operationId,
    executionAttemptId: original.executionAttemptId,
    sessionId: "original-session",
    hostId: "original-host"
  };
  return { workspace, runtime, claim, original, restoration };
}

describe("explicit stopped task restoration", () => {
  it("keeps stopped work unschedulable, then claims a fresh execution and writes back its result", async () => {
    const f = await stoppedFixture();
    const state = await readState(f.workspace.init.workspace.stateFile);
    expect(projectRemoteBlockExecution(state.blocks[f.claim.ref])).toMatchObject({
      status: "stopped",
      actionRequired: false
    });
    await expect(f.runtime.inspect({ ref: f.claim.ref })).rejects.toThrow();
    const fresh = {
      ...f.original,
      operationId: "restored-operation",
      dispatchId: "restored-dispatch",
      executionAttemptId: "restored-attempt"
    };
    await f.runtime.claim({
      ...f.claim,
      operationId: fresh.operationId,
      restoration: f.restoration
    });
    await f.runtime.activate(fresh);
    await expect(
      f.runtime.fail({
        ...f.original,
        failure: { code: "execution_cancelled", message: "Late stop.", retryable: false }
      })
    ).rejects.toThrow();
    const bytes = Buffer.from("# Implementation report\n\nTask implemented.\n");
    await f.runtime.complete({
      ...fresh,
      reportArtifactRef: `artifact:sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      reportBytes: bytes,
      transcript: {
        sessionId: "original-session",
        executor: "codex-acp",
        agentId: "codex",
        events: []
      }
    });
    const completed = await readState(f.workspace.init.workspace.stateFile);
    expect(completed.blocks[f.claim.ref].status).toBe("completed");
    expect(projectRemoteBlockExecution(completed.blocks[f.claim.ref])).toMatchObject({
      status: "completed",
      identity: { operationId: fresh.operationId }
    });
  });

  it("rejects wrong stopped identity and concurrent restoration without losing the receipt", async () => {
    const f = await stoppedFixture();
    await expect(
      f.runtime.claim({
        ...f.claim,
        operationId: "wrong",
        restoration: { ...f.restoration, operationId: "unrelated" }
      })
    ).rejects.toThrow();
    await f.runtime.claim({ ...f.claim, operationId: "first", restoration: f.restoration });
    await expect(
      f.runtime.claim({ ...f.claim, operationId: "second", restoration: f.restoration })
    ).rejects.toThrow();
  });
});
