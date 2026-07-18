import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { recordBlockRunInIndex } from "../autoRun/blockRunIndex.js";
import { codexAgentDefinition } from "../autoRun/codexIntegration.js";
import { publishAgentRunControlDescriptor } from "../autoRun/agentRunControlEndpoint.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { AcpOwnerWriteFence } from "../autoRun/acpOwnerWriteFence.js";
import { normalizedRunnerEventSchema } from "../autoRun/normalizedEventContract.js";
import { runnerPermissionInteractionRequestSchema } from "../autoRun/runnerInteractionContract.js";
import { PersistentRunnerInteractionStore } from "../autoRun/runnerInteractionStore.js";
import {
  getTaskWorkspaceRunDetail,
  getAutoRunState,
  getLatestAutoRunSummaryWithDiagnostics,
  listPendingRunnerInteractions,
  reconcileOrphanedAcpRun,
  recoverAcpRunByRecord,
  recoverTaskWorkspaceAcpRun,
  respondToRunnerInteraction,
  startAutoRun,
  shutdownDesktopAutoRuns
} from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { readState, writeState } from "../state.js";
import { trustCommand } from "../taskManager/hookTrustStore.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const acpMockAgent = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const ownerProcesses = new Set<ChildProcess>();

afterEach(async () => {
  const alive = [...ownerProcesses].filter(
    (child) => child.exitCode === null && child.signalCode === null
  );
  for (const child of alive) child.kill("SIGKILL");
  await Promise.all(alive.map((child) => once(child, "exit").catch(() => undefined)));
  ownerProcesses.clear();
  await shutdownDesktopAutoRuns();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function writeInterruptedAcpRun(options: {
  resultsDir: string;
  projectId: string;
  runId: string;
}): Promise<string> {
  const runsRoot = join(options.resultsDir, "T-001", "blocks", "B-001", "runs");
  const runDir = join(runsRoot, options.runId);
  await mkdir(runDir, { recursive: true });
  await recordBlockRunInIndex(runsRoot, options.runId);
  const metadataPath = join(runDir, "metadata.json");
  await writeJsonFile(metadataPath, {
    runId: options.runId,
    executorRunId: options.runId,
    ref: "T-001#B-001",
    claimRef: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    executor: "codex-acp",
    executorProfile: "codex-acp",
    adapter: "agent",
    runnerKind: "acp",
    agentId: "codex",
    sessionId: "source-session",
    acpLaunch: { command: "codex-acp", args: [] },
    capabilities: { loadSession: true },
    recoveryInterruptionReason: "transport_lost",
    recovery: null,
    startedAt: "2026-07-17T00:00:00.000Z",
    finishedAt: "2026-07-17T00:00:02.000Z",
    exitCode: 1
  });
  const terminal = normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence: 1,
    timestamp: "2026-07-17T00:00:02.000Z",
    identity: {
      projectId: options.projectId,
      canvasId: "default",
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
    correlation: { sessionId: "source-session" },
    body: {
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "failed",
        reason: "failed",
        cleanup: { status: "succeeded" },
        exitCode: 1,
        finishedAt: "2026-07-17T00:00:02.000Z",
        diagnostic: "ACP transport disconnected.",
        artifactValidated: false,
        nextActions: {
          version: "planweave.runner-next-actions/v1",
          actions: [
            {
              kind: "recover_acp_session",
              sourceRecordId: `T-001#B-001::${options.runId}`,
              sourceRunId: options.runId
            },
            {
              kind: "retry_new_session",
              sourceRecordId: `T-001#B-001::${options.runId}`,
              sourceRunId: options.runId
            }
          ]
        }
      }
    }
  });
  await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(terminal)}\n`, "utf8");
  return metadataPath;
}

async function createRecoveryFixture() {
  const manifest = manifestTestBuilder().withDefaultExecutor("codex-acp").build();
  const fixture = await createTestWorkspace(manifest);
  const metadataPath = await writeInterruptedAcpRun({
    resultsDir: fixture.init.workspace.resultsDir,
    projectId: fixture.init.workspace.id,
    runId: "RUN-001"
  });
  const state = await readState(fixture.init.workspace.stateFile);
  state.blocks["T-001#B-001"] = { status: "blocked", blockedReason: "ACP owner lost" };
  state.currentRefs = [];
  await writeState(fixture.init.workspace.stateFile, state);
  return { ...fixture, metadataPath };
}

async function createOrphanFixture(
  launch: { command: string; args: string[] } = { command: "codex-acp", args: [] },
  options: { ownerPid?: number; interactionCount?: number } = {}
) {
  const manifest = manifestTestBuilder().withDefaultExecutor("codex-acp").build();
  const fixture = await createTestWorkspace(manifest);
  const runId = "RUN-001";
  const runsRoot = join(fixture.init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await recordBlockRunInIndex(runsRoot, runId);
  const ownerLeaseId = "00000000-0000-4000-8000-000000000001";
  const deadOwnerPid = options.ownerPid ?? 2_147_483_647;
  const interactionIds = Array.from(
    { length: options.interactionCount ?? 1 },
    (_, index) => `permission:${index + 1}`
  );
  const metadataPath = join(runDir, "metadata.json");
  await writeJsonFile(metadataPath, {
    runId,
    executorRunId: runId,
    ref: "T-001#B-001",
    claimRef: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    projectId: fixture.init.workspace.id,
    canvasId: "default",
    executor: "codex-acp",
    executorProfile: "codex-acp",
    adapter: "agent",
    runnerKind: "acp",
    agentId: "codex",
    sessionId: "source-session",
    acpLaunch: launch,
    capabilities: { loadSession: true },
    recoveryInterruptionReason: null,
    recovery: null,
    status: "running",
    ownerLeaseId,
    ownerGeneration: 1,
    runnerLifecycle: "running",
    pendingInteractionIds: interactionIds,
    controlAvailable: true,
    controlProtocolVersion: "planweave.agent-run-control/v1",
    controlOwnerPid: deadOwnerPid,
    controlUnavailableReason: null,
    startedAt: "2026-07-17T00:00:00.000Z",
    finishedAt: null
  });
  await writeJsonFile(join(runDir, "heartbeat.json"), {
    status: "running",
    pid: null,
    startedAt: "2026-07-17T00:00:00.000Z",
    lastHeartbeatAt: "2026-07-17T00:00:01.000Z",
    finishedAt: null,
    ownerLeaseId,
    ownerGeneration: 1,
    runnerLifecycle: "running",
    pendingInteractionIds: interactionIds,
    controlAvailable: true,
    controlProtocolVersion: "planweave.agent-run-control/v1",
    controlOwnerPid: deadOwnerPid,
    controlUnavailableReason: null
  });
  await publishAgentRunControlDescriptor(runDir, {
    version: "planweave.agent-run-control/v1",
    transport: process.platform === "win32" ? "named_pipe" : "unix",
    address:
      process.platform === "win32"
        ? `\\\\.\\pipe\\planweave-dead-${ownerLeaseId}`
        : "/tmp/planweave-dead-control.sock",
    leaseId: ownerLeaseId,
    ownerPid: deadOwnerPid,
    publishedAt: "2026-07-17T00:00:00.000Z"
  });
  const interactionStore = new PersistentRunnerInteractionStore(runDir);
  for (const [index, interactionId] of interactionIds.entries()) {
    await interactionStore.createRequest(runnerPermissionInteractionRequestSchema.parse({
      version: "planweave.runner-interaction/v1",
      kind: "permission",
      identity: {
        projectId: fixture.init.workspace.id,
        canvasId: "default",
        claimRef: "T-001#B-001",
        executorRunId: runId,
        sessionId: "source-session",
        requestId: interactionId,
        ownerLeaseId,
        ownerGeneration: 1
      },
      requestedAt: "2026-07-17T00:00:01.000Z",
      summary: "Run focused tests",
      toolCallId: `tool-${index + 1}`,
      options: [
        { optionId: "allow", label: "Allow", decision: "approve" },
        { optionId: "deny", label: "Deny", decision: "deny" }
      ]
    }));
  }
  const lifecycle = normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence: 1,
    timestamp: "2026-07-17T00:00:00.000Z",
    identity: {
      projectId: fixture.init.workspace.id,
      canvasId: "default",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId,
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: runId
    },
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    correlation: { sessionId: "source-session" },
    body: { kind: "lifecycle", state: "running", message: "ACP runner is running." }
  });
  await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(lifecycle)}\n`, "utf8");
  const state = await readState(fixture.init.workspace.stateFile);
  state.blocks["T-001#B-001"] = { status: "in_progress" };
  state.currentRefs = ["T-001#B-001"];
  await writeState(fixture.init.workspace.stateFile, state);
  return { ...fixture, runDir, metadataPath };
}

async function driveAutoRunWithPermissions(
  root: string,
  runId: string
): Promise<Awaited<ReturnType<typeof getAutoRunState>>> {
  const responded = new Set<string>();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    let state: Awaited<ReturnType<typeof getAutoRunState>>;
    try {
      state = await getAutoRunState(runId);
    } catch {
      const persisted = await getLatestAutoRunSummaryWithDiagnostics(root, "default");
      if (persisted.state?.runId !== runId) throw new Error(`Auto Run '${runId}' disappeared.`);
      state = persisted.state;
    }
    if (["completed", "failed", "blocked", "stopped"].includes(state.phase)) return state;
    const pending = await listPendingRunnerInteractions({ projectRoot: root, canvasId: "default" });
    for (const snapshot of pending) {
      if (responded.has(snapshot.interactionId)) continue;
      responded.add(snapshot.interactionId);
      const option = snapshot.request.options.find((candidate) => candidate.decision === "approve");
      if (!option) throw new Error("Recovery integration permission has no approve option.");
      await respondToRunnerInteraction(
        { projectRoot: root, canvasId: "default" },
        snapshot.request.identity,
        { kind: "select", optionId: option.optionId },
        { decisionSource: "recovery-integration", reason: "Approve mock recovery action." }
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Auto Run '${runId}' did not reach a terminal phase.`);
}

describe("desktop Task Workspace ACP recovery", () => {
  it("fails closed for a stale live owner and reconciles only after that PID exits", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    });
    ownerProcesses.add(child);
    await once(child, "spawn");
    if (!child.pid) throw new Error("Owner proof child has no PID.");
    const fixture = await createOrphanFixture(undefined, { ownerPid: child.pid });
    const input = {
      projectRoot: fixture.root,
      canvasId: "default",
      recordId: "T-001#B-001::RUN-001",
      now: new Date("2026-07-17T00:01:00.000Z")
    };

    child.kill("SIGSTOP");
    await expect(reconcileOrphanedAcpRun(input)).resolves.toMatchObject({
      status: "owner_active"
    });
    child.kill("SIGCONT");
    child.kill("SIGKILL");
    await once(child, "exit");
    ownerProcesses.delete(child);
    await expect(reconcileOrphanedAcpRun(input)).resolves.toMatchObject({
      status: "reconciled"
    });
  });

  it("fences an owner write that races with the reconciliation claim", async () => {
    const fixture = await createOrphanFixture();
    const fence = new AcpOwnerWriteFence(
      fixture.runDir,
      "00000000-0000-4000-8000-000000000001",
      1
    );
    let releaseRevalidation!: () => void;
    const revalidation = new Promise<void>((resolve) => {
      releaseRevalidation = resolve;
    });
    let revalidationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      revalidationStarted = resolve;
    });
    const claim = fence.claimAfter(async () => {
      revalidationStarted();
      await revalidation;
      return true;
    }, "2026-07-17T00:01:00.000Z");
    await started;
    const ownerWrite = fence.withOwnerWrite(async () => "written");
    releaseRevalidation();

    await expect(claim).resolves.toBe(true);
    await expect(ownerWrite).rejects.toThrow("fenced by canonical orphan reconciliation");
  });

  it("retries a partial interaction event append without duplicates before terminal", async () => {
    const fixture = await createOrphanFixture(undefined, { interactionCount: 2 });
    let interactionAppendCount = 0;
    class FailSecondInteractionEventStore extends AcpEventStore {
      override append(
        body: Parameters<AcpEventStore["append"]>[0],
        correlation?: Parameters<AcpEventStore["append"]>[1]
      ): Promise<void> {
        if (body.kind === "interaction_result" && ++interactionAppendCount === 2) {
          return Promise.reject(new Error("injected second interaction append failure"));
        }
        return super.append(body, correlation);
      }
    }
    const input = {
      projectRoot: fixture.root,
      canvasId: "default",
      recordId: "T-001#B-001::RUN-001",
      now: new Date("2026-07-17T00:01:00.000Z")
    };
    await expect(
      reconcileOrphanedAcpRun(input, {
        createEventStore: (options) => new FailSecondInteractionEventStore(options)
      })
    ).rejects.toThrow("injected second interaction append failure");
    await expect(reconcileOrphanedAcpRun(input)).resolves.toMatchObject({
      status: "already_reconciled"
    });

    const events = (await readFile(join(fixture.runDir, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => normalizedRunnerEventSchema.parse(JSON.parse(line)));
    const interactionIds = events.flatMap((event) =>
      event.body.kind === "interaction_result" ? [event.body.interactionId] : []
    );
    expect(interactionIds).toHaveLength(2);
    expect(new Set(interactionIds).size).toBe(2);
    expect(events.filter((event) => event.body.kind === "terminal")).toHaveLength(1);
  });

  it("reconciles a stale nonterminal owner once and exposes recovery from canonical terminal facts", async () => {
    const fixture = await createOrphanFixture();
    const now = new Date("2026-07-17T00:01:00.000Z");

    await expect(
      reconcileOrphanedAcpRun({
        projectRoot: fixture.root,
        canvasId: "default",
        recordId: "T-001#B-001::RUN-001",
        now
      })
    ).resolves.toMatchObject({ status: "reconciled" });
    const canonicalSource = await readFile(fixture.metadataPath, "utf8");
    await expect(
      reconcileOrphanedAcpRun({
        projectRoot: fixture.root,
        canvasId: "default",
        recordId: "T-001#B-001::RUN-001",
        now
      })
    ).resolves.toMatchObject({ status: "already_reconciled" });
    expect(await readFile(fixture.metadataPath, "utf8")).toBe(canonicalSource);

    const events = (await readFile(join(fixture.runDir, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => normalizedRunnerEventSchema.parse(JSON.parse(line)));
    expect(events.filter((event) => event.body.kind === "terminal")).toHaveLength(1);
    expect(events.filter((event) => event.body.kind === "interaction_result")).toHaveLength(1);
    await expect(
      new PersistentRunnerInteractionStore(fixture.runDir).readSnapshot("permission:1")
    ).resolves.toMatchObject({
      status: "expired",
      ownerResult: { reason: "terminal_cleanup", outcome: "expired" }
    });
    expect(JSON.parse(canonicalSource)).toMatchObject({
      status: "failed",
      recoveryInterruptionReason: "owner_lost",
      runnerLifecycle: "terminal",
      pendingInteractionIds: []
    });
    expect((await readState(fixture.init.workspace.stateFile)).blocks["T-001#B-001"]).toMatchObject(
      {
        status: "blocked"
      }
    );

    const detail = await getTaskWorkspaceRunDetail(
      {
        projectRoot: fixture.root,
        canvasId: "default",
        taskId: "T-001",
        recordId: "T-001#B-001::RUN-001"
      },
      { selectedRecordId: "T-001#B-001::RUN-001", now }
    );
    expect(detail.item.run.capabilities.recoverAcpSession.available).toBe(true);
    expect(detail.item.run.nextActions.actions.map((action) => action.kind)).toEqual([
      "recover_acp_session",
      "retry_new_session"
    ]);
  });

  it("filters a canonical recover candidate when persisted load capability drifts", async () => {
    const fixture = await createRecoveryFixture();
    const metadata = JSON.parse(await readFile(fixture.metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeJsonFile(fixture.metadataPath, {
      ...metadata,
      capabilities: { loadSession: false }
    });
    const detail = await getTaskWorkspaceRunDetail({
      projectRoot: fixture.root,
      canvasId: "default",
      taskId: "T-001",
      recordId: "T-001#B-001::RUN-001"
    });

    expect(detail.item.run.capabilities.recoverAcpSession.available).toBe(false);
    expect(detail.item.run.nextActions.actions.map((action) => action.kind)).toEqual([
      "retry_new_session"
    ]);
  });

  it("loads the orphan session, handles a new-lease permission, and submits a new artifact", async () => {
    const previousLaunch = codexAgentDefinition.acp.launch;
    const launch = {
      command: process.execPath,
      args: [acpMockAgent, "recovery-permission-artifact"],
      source: previousLaunch?.source ?? "built_in"
    };
    codexAgentDefinition.acp.launch = launch;
    try {
      const fixture = await createOrphanFixture({ command: launch.command, args: launch.args });
      await trustCommand(fixture.init.workspace, launch.command, launch.args);
      const now = new Date("2026-07-17T00:01:00.000Z");
      await reconcileOrphanedAcpRun({
        projectRoot: fixture.root,
        canvasId: "default",
        recordId: "T-001#B-001::RUN-001",
        now
      });
      const sourceMetadata = await readFile(fixture.metadataPath, "utf8");
      const sourceEvents = await readFile(join(fixture.runDir, "events.ndjson"), "utf8");
      const detail = await getTaskWorkspaceRunDetail(
        {
          projectRoot: fixture.root,
          canvasId: "default",
          taskId: "T-001",
          recordId: "T-001#B-001::RUN-001"
        },
        { selectedRecordId: "T-001#B-001::RUN-001", now }
      );
      const recovery = detail.item.run.capabilities.recoverAcpSession;
      if (!recovery.available || recovery.identity === null) {
        throw new Error("Expected the reconciled source to expose ACP recovery.");
      }

      const recoveryResult = await recoverAcpRunByRecord(
        {
          projectRoot: fixture.root,
          canvasId: "default",
          recordId: "T-001#B-001::RUN-001"
        },
        {
        source: "recovery-integration",
        reason: "Resume the orphaned mock ACP session."
        }
      );
      expect(recoveryResult.nextActions.actions).toEqual([]);
      expect(recoveryResult.detail.item.run.nextActions).toEqual(recoveryResult.nextActions);
      const recoveryState = recoveryResult.state;
      const terminal = await driveAutoRunWithPermissions(fixture.root, recoveryState.runId);
      expect(terminal).toMatchObject({ phase: "completed", error: null });

      const state = await readState(fixture.init.workspace.stateFile);
      expect(state.blocks["T-001#B-001"]).toMatchObject({ status: "completed" });
      const runsRoot = join(fixture.init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
      const recoveryMetadata = JSON.parse(
        await readFile(join(runsRoot, "RUN-002", "metadata.json"), "utf8")
      );
      expect(recoveryMetadata).toMatchObject({
        status: "completed",
        sessionId: "source-session",
        recovery: { sourceRunId: "RUN-001", sourceSessionId: "source-session" }
      });
      await expect(readFile(join(runsRoot, "RUN-002", "report.md"), "utf8")).resolves.toBe(
        "recovered implementation\n"
      );
      const reviewRun = await startAutoRun(fixture.root, "default", { kind: "project" }, 20);
      const reviewed = await driveAutoRunWithPermissions(fixture.root, reviewRun.runId);
      expect(reviewed).toMatchObject({ phase: "completed", error: null });
      expect(
        (await readState(fixture.init.workspace.stateFile)).blocks["T-001#R-001"]
      ).toMatchObject({ status: "completed" });
      expect(await readFile(fixture.metadataPath, "utf8")).toBe(sourceMetadata);
      expect(await readFile(join(fixture.runDir, "events.ndjson"), "utf8")).toBe(sourceEvents);
    } finally {
      await shutdownDesktopAutoRuns();
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  }, 20_000);

  it("projects recovery separately from retry and creates only one lineage-linked attempt", async () => {
    const fixture = await createRecoveryFixture();
    const sourceMetadata = await readFile(fixture.metadataPath, "utf8");
    const detail = await getTaskWorkspaceRunDetail(
      {
        projectRoot: fixture.root,
        canvasId: "default",
        taskId: "T-001",
        recordId: "T-001#B-001::RUN-001"
      },
      { selectedRecordId: "T-001#B-001::RUN-001" }
    );
    const recovery = detail.item.run.capabilities.recoverAcpSession;
    expect(recovery.available).toBe(true);
    expect(recovery.identity).toMatchObject({
      recordId: "T-001#B-001::RUN-001",
      runId: "RUN-001",
      sessionId: "source-session",
      agentId: "codex",
      executorProfile: "codex-acp",
      launch: { command: "codex-acp", args: [] }
    });
    expect(detail.item.run.capabilities.retry.available).toBe(true);
    if (!recovery.identity) throw new Error("Expected an ACP recovery identity.");

    const attempts = await Promise.allSettled([
      recoverTaskWorkspaceAcpRun(recovery.identity, {
        source: "coordinator-a",
        reason: "recover interrupted session"
      }),
      recoverTaskWorkspaceAcpRun(recovery.identity, {
        source: "coordinator-b",
        reason: "recover interrupted session"
      })
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const recoveryResult = fulfilled[0]?.status === "fulfilled" ? fulfilled[0].value : null;
    expect(recoveryResult?.state.options.acpRecovery).toMatchObject({
      claimRef: "T-001#B-001",
      lineage: {
        version: "planweave.acp-recovery/v1",
        kind: "session_load",
        sourceRecordId: "T-001#B-001::RUN-001",
        sourceRunId: "RUN-001",
        sourceSessionId: "source-session",
        sourceTerminalEventSequence: 1
      }
    });
    expect(recoveryResult?.detail.item.run.nextActions).toEqual(recoveryResult?.nextActions);
    expect(await readFile(fixture.metadataPath, "utf8")).toBe(sourceMetadata);
  });

  it("fails closed when the current executor profile no longer matches", async () => {
    const fixture = await createRecoveryFixture();
    const manifest = manifestTestBuilder().withDefaultExecutor("claude-code-acp").build();
    await writeJsonFile(fixture.init.workspace.manifestFile, manifest);

    const detail = await getTaskWorkspaceRunDetail(
      {
        projectRoot: fixture.root,
        canvasId: "default",
        taskId: "T-001",
        recordId: "T-001#B-001::RUN-001"
      },
      { selectedRecordId: "T-001#B-001::RUN-001" }
    );

    expect(detail.item.run.capabilities.recoverAcpSession).toMatchObject({
      available: false,
      reason: { code: "agent_mismatch" },
      identity: null
    });
    expect(detail.item.run.nextActions.actions.map((action) => action.kind)).toEqual([
      "retry_new_session"
    ]);
  });
});
