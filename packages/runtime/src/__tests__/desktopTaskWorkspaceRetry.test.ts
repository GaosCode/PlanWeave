import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonFile } from "../json.js";
import { normalizedRunnerEventSchema } from "../autoRun/normalizedEventContract.js";
import { recordBlockRunArtifactInIndex, recordBlockRunInIndex } from "../autoRun/blockRunIndex.js";
import {
  composeTaskWorkspaceRuns,
  getTaskWorkspace,
  getTaskWorkspaceRunDetail,
  listTaskWorkspaceRuns,
  retryTaskWorkspaceRun,
  duplicateTaskCanvas,
  resolveTaskCanvasWorkspace,
  selectTaskCanvas,
  shutdownDesktopAutoRuns,
  startAutoRun,
  type TaskWorkspace,
  type TaskWorkspaceInput
} from "../desktop/index.js";
import { readState, writeState } from "../state.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(async () => {
  await shutdownDesktopAutoRuns();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function loadComposedTaskWorkspace(
  input: TaskWorkspaceInput,
  options: { now?: Date } = {}
): Promise<TaskWorkspace> {
  const header = await getTaskWorkspace(input, options);
  const page = await listTaskWorkspaceRuns(
    {
      projectRoot: input.projectRoot,
      canvasId: input.canvasId,
      taskId: input.taskId
    },
    { now: options.now, selectedRecordId: header.selectedRecordId }
  );
  let composed = composeTaskWorkspaceRuns(header, page.items, options);
  const selectedId = composed.selectedRecordId;
  if (selectedId) {
    const detail = await getTaskWorkspaceRunDetail(
      {
        projectRoot: input.projectRoot,
        canvasId: input.canvasId,
        taskId: input.taskId,
        recordId: selectedId
      },
      { now: options.now, selectedRecordId: selectedId }
    );
    composed = composeTaskWorkspaceRuns(
      composed,
      [
        ...page.items.filter((item) => item.run.record.recordId !== selectedId),
        { blockRef: detail.blockRef, ...detail.item }
      ],
      options
    );
  }
  return composed;
}

async function writeBlockRun(options: {
  resultsDir: string;
  blockId: string;
  runId: string;
  startedAt?: string;
  finishedAt?: string | null;
  report?: string;
  executionWaveId?: string;
}): Promise<void> {
  const ref = `T-001#${options.blockId}`;
  const runsRoot = join(options.resultsDir, "T-001", "blocks", options.blockId, "runs");
  const runDir = join(runsRoot, options.runId);
  await mkdir(runDir, { recursive: true });
  await recordBlockRunInIndex(runsRoot, options.runId);
  await writeJsonFile(join(runDir, "metadata.json"), {
    runId: options.runId,
    ref,
    executor: "codex",
    adapter: "codex-exec",
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    executionWaveId: options.executionWaveId,
    exitCode: options.finishedAt ? 0 : null
  });
  if (options.report !== undefined) {
    await writeFile(join(runDir, "report.md"), options.report, "utf8");
    await recordBlockRunArtifactInIndex(runsRoot, options.runId);
  }
}

async function writeTerminalRunnerEvents(options: {
  resultsDir: string;
  projectId: string;
  runId: string;
  canvasId?: string;
  terminalState?: "failed" | "succeeded" | "cancelled";
}): Promise<void> {
  const terminalState = options.terminalState ?? "failed";
  const canvasId = options.canvasId ?? "default";
  const runDir = join(options.resultsDir, "T-001", "blocks", "B-001", "runs", options.runId);
  const event = normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence: 1,
    timestamp: "2026-07-13T00:00:02.000Z",
    identity: {
      projectId: options.projectId,
      canvasId,
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId: options.runId,
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: options.runId
    },
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    correlation: { sessionId: "session-1" },
    body: {
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: terminalState,
        reason: terminalState === "succeeded" ? "completed" : terminalState,
        cleanup: { status: "succeeded" },
        exitCode: terminalState === "succeeded" ? 0 : terminalState === "failed" ? 1 : null,
        finishedAt: "2026-07-13T00:00:02.000Z",
        diagnostic: null,
        artifactValidated: terminalState === "succeeded"
      }
    }
  });
  await writeJsonFile(join(runDir, "metadata.json"), {
    runId: options.runId,
    executorRunId: options.runId,
    ref: "T-001#B-001",
    claimRef: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    executor: "codex",
    adapter: "agent",
    runnerKind: "acp",
    agentId: "codex",
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:00:02.000Z",
    exitCode: terminalState === "succeeded" ? 0 : terminalState === "failed" ? 1 : null
  });
  await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
}

describe("desktop Task Workspace retry", () => {
  it("offers an exact retry only for the latest failed run of a blocked dependency-ready Block", async () => {
    const { root, init } = await createTestWorkspace();
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:02.000Z"
    });
    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-001"
    });
    const state = await readState(init.workspace.stateFile);
    state.blocks["T-001#B-001"] = {
      status: "blocked",
      blockedReason: "executor failed"
    };
    state.currentRefs = [];
    await writeState(init.workspace.stateFile, state);

    const workspace = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });
    const selected = workspace.blocks[0]?.runs[0];

    expect(selected?.run.capabilities.retry).toEqual({
      available: true,
      reason: null,
      identity: {
        version: "planweave.task-workspace-retry/v1",
        projectId: init.workspace.id,
        projectRoot: init.workspace.rootPath,
        canvasId: "default",
        taskId: "T-001",
        blockId: "B-001",
        claimRef: "T-001#B-001",
        recordId: "T-001#B-001::RUN-001",
        runId: "RUN-001",
        executorRunId: "RUN-001"
      }
    });

    state.blocks["T-001#B-001"] = { status: "ready", blockedReason: null };
    await writeState(init.workspace.stateFile, state);
    const notBlocked = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });
    expect(notBlocked.blocks[0]?.runs[0]?.run.capabilities.retry.available).toBe(false);

    state.blocks["T-001#B-001"] = { status: "blocked", blockedReason: "executor failed" };
    await writeState(init.workspace.stateFile, state);
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-002",
      startedAt: "2026-07-13T00:00:03.000Z",
      finishedAt: "2026-07-13T00:00:04.000Z"
    });
    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-002"
    });
    const historical = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });
    expect(historical.blocks[0]?.runs[0]?.run.capabilities.retry.available).toBe(false);

    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-002",
      terminalState: "succeeded"
    });
    const succeeded = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-002"
    });
    expect(succeeded.blocks[0]?.runs[1]?.run.capabilities.retry.available).toBe(false);

    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-002",
      terminalState: "cancelled"
    });
    const cancelled = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-002"
    });
    expect(cancelled.blocks[0]?.runs[1]?.run.capabilities.retry.available).toBe(false);
  });

  it("revalidates retry identity, unblocks the Block, and starts a new block-scoped Auto Run", async () => {
    const { root, init } = await createTestWorkspace();
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:02.000Z"
    });
    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-001"
    });
    const state = await readState(init.workspace.stateFile);
    state.blocks["T-001#B-001"] = { status: "blocked", blockedReason: "executor failed" };
    state.currentRefs = [];
    await writeState(init.workspace.stateFile, state);
    const before = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });
    const identity = before.blocks[0]?.runs[0]?.run.capabilities.retry.identity;
    if (!identity) throw new Error("Expected an available retry identity.");

    const autoRun = await retryTaskWorkspaceRun(identity);

    expect(autoRun.scope).toEqual({ kind: "block", blockRef: "T-001#B-001" });
    expect(autoRun.latestRecordId).toBeNull();
    expect(identity.recordId).toBe("T-001#B-001::RUN-001");
  });

  it("withholds retry when a failed blocked Block still has an incomplete dependency", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes[0];
    const implementation = task.blocks[0];
    if (implementation?.type !== "implementation") {
      throw new Error("Expected the basic implementation Block.");
    }
    implementation.depends_on = ["B-002"];
    task.blocks.splice(1, 0, {
      id: "B-002",
      type: "implementation",
      title: "Dependency",
      prompt: "nodes/T-001/blocks/B-002.prompt.md",
      depends_on: []
    });
    const { root, init } = await createTestWorkspace(manifest);
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:02.000Z"
    });
    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-001"
    });
    const state = await readState(init.workspace.stateFile);
    state.blocks["T-001#B-001"] = { status: "blocked", blockedReason: "executor failed" };
    await writeState(init.workspace.stateFile, state);

    const workspace = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });

    const blocked = workspace.blocks.find((block) => block.ref === "T-001#B-001");
    expect(blocked?.dependencies.blockers).toEqual(["T-001#B-002"]);
    expect(blocked?.runs[0]?.run.capabilities.retry.available).toBe(false);
  });

  it("withholds retry while another Auto Run is active on the canvas", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:02.000Z"
    });
    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-001"
    });
    const state = await readState(init.workspace.stateFile);
    state.blocks["T-001#B-001"] = { status: "blocked", blockedReason: "executor failed" };
    await writeState(init.workspace.stateFile, state);
    await startAutoRun(root, "default", { kind: "block", blockRef: "T-002#B-001" });

    const workspace = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });

    expect(workspace.blocks[0]?.runs[0]?.run.capabilities.retry.available).toBe(false);
  });

  it("keeps the Block ready and reports a readable error when starting the retry Auto Run fails", async () => {
    const { root, init } = await createTestWorkspace();
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:02.000Z"
    });
    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-001"
    });
    const state = await readState(init.workspace.stateFile);
    state.blocks["T-001#B-001"] = { status: "blocked", blockedReason: "executor failed" };
    await writeState(init.workspace.stateFile, state);
    const before = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });
    const identity = before.blocks[0]?.runs[0]?.run.capabilities.retry.identity;
    if (!identity) throw new Error("Expected an available retry identity.");
    const autoRunsPath = join(init.workspace.resultsDir, "auto-runs");
    await writeFile(autoRunsPath, "prevent Auto Run directory creation", "utf8");
    try {
      await expect(retryTaskWorkspaceRun(identity)).rejects.toThrow(/Block remains ready/);
    } finally {
      await rm(autoRunsPath, { force: true });
    }
    const after = await readState(init.workspace.stateFile);
    expect(after.blocks["T-001#B-001"]?.status).toBe("ready");
    expect(after.blocks["T-001#B-001"]?.blockedReason).toBeNull();
  });

  it("fails closed without unblocking when persisted Auto Run state is corrupt", async () => {
    const { root, init } = await createTestWorkspace();
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      finishedAt: "2026-07-13T00:00:02.000Z"
    });
    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-001"
    });
    const state = await readState(init.workspace.stateFile);
    state.blocks["T-001#B-001"] = { status: "blocked", blockedReason: "executor failed" };
    await writeState(init.workspace.stateFile, state);
    const before = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });
    const identity = before.blocks[0]?.runs[0]?.run.capabilities.retry.identity;
    if (!identity) throw new Error("Expected an available retry identity.");
    const corruptStatePath = join(
      init.workspace.resultsDir,
      "auto-runs",
      "DESKTOP-RUN-9001",
      "state.json"
    );
    await mkdir(dirname(corruptStatePath), { recursive: true });
    await writeFile(corruptStatePath, "{", "utf8");

    await expect(retryTaskWorkspaceRun(identity)).rejects.toThrow(
      /persisted Auto Run state is unreadable.*not valid JSON/
    );
    const unchanged = await readState(init.workspace.stateFile);
    expect(unchanged.blocks[identity.claimRef]).toMatchObject({
      status: "blocked",
      blockedReason: "executor failed"
    });
  });

  it("unblocks the identity Canvas when the active Canvas is different", async () => {
    const { root, init } = await createTestWorkspace();
    const targetCanvas = await duplicateTaskCanvas(root, "default", { name: "Retry target" });
    const targetWorkspace = await resolveTaskCanvasWorkspace(root, targetCanvas.canvasId);
    await writeBlockRun({
      resultsDir: targetWorkspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:02.000Z"
    });
    await writeTerminalRunnerEvents({
      resultsDir: targetWorkspace.resultsDir,
      projectId: targetWorkspace.id,
      canvasId: targetCanvas.canvasId,
      runId: "RUN-001"
    });
    const targetState = await readState(targetWorkspace.stateFile);
    targetState.blocks["T-001#B-001"] = {
      status: "blocked",
      blockedReason: "target executor failed"
    };
    await writeState(targetWorkspace.stateFile, targetState);
    const defaultState = await readState(init.workspace.stateFile);
    defaultState.blocks["T-001#B-001"] = {
      status: "blocked",
      blockedReason: "active Canvas sentinel"
    };
    await writeState(init.workspace.stateFile, defaultState);
    await selectTaskCanvas(root, "default");

    const before = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: targetCanvas.canvasId,
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });
    const identity = before.blocks[0]?.runs[0]?.run.capabilities.retry.identity;
    if (!identity) throw new Error("Expected an available retry identity.");

    const started = await retryTaskWorkspaceRun(identity);

    expect(started.canvasId).toBe(targetCanvas.canvasId);
    expect(started.scope).toEqual({ kind: "block", blockRef: "T-001#B-001" });
    const unchangedDefault = await readState(init.workspace.stateFile);
    expect(unchangedDefault.blocks["T-001#B-001"]).toMatchObject({
      status: "blocked",
      blockedReason: "active Canvas sentinel"
    });
    const changedTarget = await readState(targetWorkspace.stateFile);
    expect(changedTarget.blocks["T-001#B-001"]?.status).not.toBe("blocked");
  });

  it("rejects project and executor run identity field tampering", async () => {
    const { root, init } = await createTestWorkspace();
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      finishedAt: "2026-07-13T00:00:02.000Z"
    });
    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-001"
    });
    const state = await readState(init.workspace.stateFile);
    state.blocks["T-001#B-001"] = { status: "blocked", blockedReason: "executor failed" };
    await writeState(init.workspace.stateFile, state);
    const before = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });
    const identity = before.blocks[0]?.runs[0]?.run.capabilities.retry.identity;
    if (!identity) throw new Error("Expected an available retry identity.");

    await expect(
      retryTaskWorkspaceRun({ ...identity, projectId: `${identity.projectId}-tampered` })
    ).rejects.toThrow(/identity no longer matches the requested workspace/);
    await expect(
      retryTaskWorkspaceRun({
        ...identity,
        runId: "RUN-TAMPERED",
        executorRunId: "RUN-TAMPERED",
        recordId: `${identity.claimRef}::RUN-TAMPERED`
      })
    ).rejects.toThrow();
    const unchanged = await readState(init.workspace.stateFile);
    expect(unchanged.blocks[identity.claimRef]?.status).toBe("blocked");
  });

  it("serializes retry validation with a concurrent normal Canvas start", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      finishedAt: "2026-07-13T00:00:02.000Z"
    });
    await writeTerminalRunnerEvents({
      resultsDir: init.workspace.resultsDir,
      projectId: init.workspace.id,
      runId: "RUN-001"
    });
    const state = await readState(init.workspace.stateFile);
    state.blocks["T-001#B-001"] = { status: "blocked", blockedReason: "executor failed" };
    await writeState(init.workspace.stateFile, state);
    const before = await loadComposedTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-001"
    });
    const identity = before.blocks[0]?.runs[0]?.run.capabilities.retry.identity;
    if (!identity) throw new Error("Expected an available retry identity.");

    const normalStart = startAutoRun(
      root,
      "default",
      { kind: "block", blockRef: "T-002#B-001" },
      20,
      { tmuxEnabled: false }
    );
    const retry = retryTaskWorkspaceRun(identity);

    const results = await Promise.allSettled([normalStart, retry]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<typeof normalStart>> =>
        result.status === "fulfilled"
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [rejectedStart] = rejected;
    if (!rejectedStart) {
      throw new Error("Expected one concurrent start to be rejected");
    }
    expect(rejectedStart.reason).toBeInstanceOf(Error);
    expect((rejectedStart.reason as Error).message).toMatch(/active(?: or resumable)?/);

    const finalState = await readState(init.workspace.stateFile);
    const [fulfilledStart] = fulfilled;
    if (!fulfilledStart) {
      throw new Error("Expected one concurrent start to be fulfilled");
    }
    const winningScope = fulfilledStart.value.scope;
    if (winningScope.kind === "block" && winningScope.blockRef === identity.claimRef) {
      expect(finalState.blocks[identity.claimRef]?.status).not.toBe("blocked");
    } else {
      expect(winningScope).toEqual({ kind: "block", blockRef: "T-002#B-001" });
      expect(finalState.blocks[identity.claimRef]?.status).toBe("blocked");
    }
  });
});
