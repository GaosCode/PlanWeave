import { chmod, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  type RunnerInteractionApiError,
  listPendingRunnerInteractions,
  respondToRunnerInteraction,
  respondToRunnerInteractionAction
} from "../desktop/runnerInteractionApi.js";
import { PersistentRunnerInteractionStore } from "../autoRun/runnerInteractionStore.js";
import { writeJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { AcpSessionController, type AcpSessionRun } from "../autoRun/acpSessionController.js";
import { ActiveAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";

const lease = "11111111-1111-4111-8111-111111111111";
const now = new Date();
const acpFixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const apiWorker = fileURLToPath(
  new URL("./support/runnerInteractionApiWorker.ts", import.meta.url)
);
const acceptedControl = vi.fn(async () => ({
  ok: true as const,
  commandId: "44444444-4444-4444-8444-444444444444",
  acceptedAt: now.toISOString(),
  result: { status: "delivered" as const, deliveredAt: now.toISOString() }
}));

async function createPendingRun(options: { feedbackId?: string } = {}) {
  const { root, init } = await createTestWorkspace();
  const runDir = options.feedbackId
    ? join(init.workspace.resultsDir, "feedback-runs", "RUN-001")
    : join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
  await mkdir(runDir, { recursive: true });
  await chmod(runDir, 0o700);
  const identity = {
    projectId: init.workspace.id,
    canvasId: "default",
    claimRef: "T-001#B-001",
    executorRunId: "RUN-001",
    sessionId: "session-1",
    requestId: "permission-1",
    ownerLeaseId: lease,
    ownerGeneration: 1
  } as const;
  await writeJsonFile(join(runDir, "metadata.json"), {
    ...(options.feedbackId ? { feedbackId: options.feedbackId } : {}),
    runnerKind: "acp",
    runId: "RUN-001",
    executorRunId: "RUN-001",
    ref: identity.claimRef,
    projectId: identity.projectId,
    canvasId: identity.canvasId,
    sessionId: identity.sessionId,
    ownerLeaseId: lease,
    ownerGeneration: 1,
    status: "running",
    desktopRunId: "AUTO-RUN-001",
    runSessionId: "SESSION-001",
    claimRef: identity.claimRef
  });
  await writeJsonFile(join(runDir, "heartbeat.json"), {
    status: "running",
    pid: null,
    startedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString(),
    finishedAt: null,
    ownerLeaseId: lease,
    ownerGeneration: 1,
    runnerLifecycle: "waiting_interaction",
    pendingInteractionIds: [identity.requestId]
  });
  await new PersistentRunnerInteractionStore(runDir).createRequest({
    version: "planweave.runner-interaction/v1",
    kind: "permission",
    identity,
    requestedAt: now.toISOString(),
    summary: "Allow the safe operation?",
    toolCallId: "tool-1",
    options: [
      { optionId: "allow_once", label: "Allow once", decision: "approve" },
      { optionId: "reject_once", label: "Reject", decision: "deny" }
    ]
  });
  return {
    root,
    runDir,
    identity,
    recordId: options.feedbackId
      ? `${options.feedbackId}::RUN-001`
      : `${identity.claimRef}::RUN-001`
  };
}

describe("desktop runner interaction API", () => {
  it("lets a second Runtime process discover and answer the canonical owner run", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await mkdir(runDir, { recursive: true });
    const run: AcpSessionRun = {
      kind: "implementation",
      identity: {
        scope: runDir,
        desktopRunId: "AUTO-RUN-001",
        runSessionId: "SESSION-001",
        executorRunId: "RUN-001",
        claimRef: "T-001#B-001"
      },
      runDir,
      metadataPath: join(runDir, "metadata.json"),
      prompt: "permission-secret",
      cwd: root,
      launch: { command: process.execPath, args: [acpFixture, "permission-secret"] },
      executorName: "mock-acp",
      agentId: "codex",
      taskId: "T-001",
      metadataIdentity: { blockId: "B-001" },
      projectId: init.workspace.id,
      canvasId: "default"
    };
    const execution = new AcpSessionController(new ActiveAgentRunRegistry()).execute(run, {
      timeoutMs: 5_000
    });
    const worker = spawn(process.execPath, ["--import", "tsx", apiWorker, root], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let workerError = "";
    worker.stdout.setEncoding("utf8");
    worker.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    worker.stderr.setEncoding("utf8");
    worker.stderr.on("data", (chunk: string) => {
      workerError += chunk;
    });
    const workerCompleted = new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`Runner interaction API worker exited with ${String(code)}: ${workerError}`)
          );
      });
    });
    await expect(Promise.all([execution, workerCompleted])).resolves.toBeDefined();
    expect(output).toContain('"decisionSource":"runtime-worker"');
  }, 15_000);

  it("lists but does not report success when the owner endpoint is unavailable", async () => {
    const fixture = await createPendingRun();
    await expect(
      listPendingRunnerInteractions({ projectRoot: fixture.root, canvasId: "default" })
    ).resolves.toMatchObject([{ status: "pending", request: { identity: fixture.identity } }]);

    await expect(
      respondToRunnerInteraction(
        { projectRoot: fixture.root, canvasId: "default" },
        fixture.identity,
        { kind: "select", optionId: "allow_once" },
        { decisionSource: "scheduler-alpha", reason: null },
        { now: () => now }
      )
    ).rejects.toMatchObject<RunnerInteractionApiError>({
      code: "interaction_owner_unavailable"
    });
    await expect(
      new PersistentRunnerInteractionStore(fixture.runDir).readSnapshot(fixture.identity.requestId)
    ).resolves.toMatchObject({ status: "pending", response: null });
  });

  it("rejects stale owners, then accepts the same lease after heartbeat recovery", async () => {
    const fixture = await createPendingRun();
    await writeJsonFile(join(fixture.runDir, "heartbeat.json"), {
      status: "running",
      pid: null,
      startedAt: now.toISOString(),
      lastHeartbeatAt: new Date(now.getTime() - 60_000).toISOString(),
      finishedAt: null,
      ownerLeaseId: lease,
      ownerGeneration: 1,
      runnerLifecycle: "waiting_interaction",
      pendingInteractionIds: [fixture.identity.requestId]
    });
    const respond = () =>
      respondToRunnerInteraction(
        { projectRoot: fixture.root, canvasId: "default" },
        fixture.identity,
        { kind: "select", optionId: "reject_once" },
        { decisionSource: "scheduler-alpha", reason: "Not approved" },
        { now: () => now }
      );
    await expect(respond()).rejects.toMatchObject<RunnerInteractionApiError>({
      code: "interaction_owner_unavailable"
    });
    await expect(
      listPendingRunnerInteractions({ projectRoot: fixture.root, canvasId: "default" })
    ).resolves.toEqual([]);
    await writeJsonFile(join(fixture.runDir, "heartbeat.json"), {
      status: "running",
      pid: null,
      startedAt: now.toISOString(),
      lastHeartbeatAt: now.toISOString(),
      finishedAt: null,
      ownerLeaseId: lease,
      ownerGeneration: 1,
      runnerLifecycle: "waiting_interaction",
      pendingInteractionIds: [fixture.identity.requestId]
    });
    await expect(
      respondToRunnerInteraction(
        { projectRoot: fixture.root, canvasId: "default" },
        fixture.identity,
        { kind: "select", optionId: "reject_once" },
        { decisionSource: "scheduler-alpha", reason: "Not approved" },
        { now: () => now, executeControl: acceptedControl }
      )
    ).resolves.toMatchObject({ selectedOption: { decision: "deny" } });
  });

  it("rejects a replaced owner lease before creating a response", async () => {
    const fixture = await createPendingRun();
    await writeJsonFile(join(fixture.runDir, "heartbeat.json"), {
      status: "running",
      pid: null,
      startedAt: now.toISOString(),
      lastHeartbeatAt: now.toISOString(),
      finishedAt: null,
      ownerLeaseId: "22222222-2222-4222-8222-222222222222",
      ownerGeneration: 2,
      runnerLifecycle: "waiting_interaction",
      pendingInteractionIds: [fixture.identity.requestId]
    });
    await expect(
      respondToRunnerInteraction(
        { projectRoot: fixture.root, canvasId: "default" },
        fixture.identity,
        { kind: "select", optionId: "allow_once" },
        { decisionSource: "scheduler-alpha", reason: null },
        { now: () => now }
      )
    ).rejects.toMatchObject<RunnerInteractionApiError>({ code: "interaction_owner_replaced" });
  });

  it("responds to a canonical feedback record and enforces action CAS identities", async () => {
    const fixture = await createPendingRun({ feedbackId: "FE-001" });
    const ref = { projectRoot: fixture.root, canvasId: "default" };
    const action = {
      recordId: fixture.recordId,
      requestId: fixture.identity.requestId,
      ownerLeaseId: lease
    };
    const audit = { decisionSource: "planweave-desktop", reason: null };
    const executeControl = vi
      .fn()
      .mockResolvedValueOnce(await acceptedControl())
      .mockResolvedValueOnce({
        ok: false,
        commandId: "55555555-5555-4555-8555-555555555555",
        code: "request_not_pending",
        message: "Request is no longer pending."
      });

    await expect(
      respondToRunnerInteractionAction(
        ref,
        action,
        { kind: "select", optionId: "allow_once" },
        audit,
        { now: () => now, executeControl }
      )
    ).resolves.toMatchObject({ selectedOption: { decision: "approve" } });
    await expect(
      respondToRunnerInteractionAction(
        ref,
        action,
        { kind: "cancel" },
        {
          ...audit,
          reason: "No longer needed"
        },
        { executeControl }
      )
    ).rejects.toMatchObject<RunnerInteractionApiError>({
      code: "interaction_already_answered"
    });
  });

  it("rejects feedback record, request, and lease identity mismatches with stable codes", async () => {
    const fixture = await createPendingRun({ feedbackId: "FE-001" });
    const ref = { projectRoot: fixture.root, canvasId: "default" };
    const action = {
      recordId: fixture.recordId,
      requestId: fixture.identity.requestId,
      ownerLeaseId: lease
    };
    const audit = { decisionSource: "planweave-desktop", reason: "Cancelled in test" };
    await expect(
      respondToRunnerInteractionAction(
        ref,
        { ...action, recordId: "FE-002::RUN-001" },
        { kind: "cancel" },
        audit
      )
    ).rejects.toMatchObject<RunnerInteractionApiError>({ code: "interaction_identity_mismatch" });
    await expect(
      respondToRunnerInteractionAction(
        ref,
        { ...action, requestId: "permission-other" },
        { kind: "cancel" },
        audit
      )
    ).rejects.toMatchObject<RunnerInteractionApiError>({ code: "interaction_not_found" });
    await expect(
      respondToRunnerInteractionAction(
        ref,
        { ...action, ownerLeaseId: "22222222-2222-4222-8222-222222222222" },
        { kind: "cancel" },
        audit
      )
    ).rejects.toMatchObject<RunnerInteractionApiError>({ code: "interaction_owner_replaced" });
  });

  it("maps every invalid public input to the stable contract error code", async () => {
    const fixture = await createPendingRun();
    const ref = { projectRoot: fixture.root, canvasId: "default" };
    const audit = { decisionSource: "scheduler-alpha", reason: null };
    await expect(
      listPendingRunnerInteractions({ projectRoot: "", canvasId: "default" })
    ).rejects.toMatchObject<RunnerInteractionApiError>({ code: "interaction_contract_invalid" });
    await expect(
      respondToRunnerInteraction(
        ref,
        { ...fixture.identity, requestId: "" },
        { kind: "cancel" },
        audit
      )
    ).rejects.toMatchObject<RunnerInteractionApiError>({ code: "interaction_contract_invalid" });
    await expect(
      respondToRunnerInteraction(ref, fixture.identity, { kind: "select", optionId: "" }, audit)
    ).rejects.toMatchObject<RunnerInteractionApiError>({ code: "interaction_contract_invalid" });
    await expect(
      respondToRunnerInteraction(
        ref,
        fixture.identity,
        { kind: "cancel" },
        { ...audit, decisionSource: "" }
      )
    ).rejects.toMatchObject<RunnerInteractionApiError>({ code: "interaction_contract_invalid" });
  });

  it("preserves the advertised-option error and rejects terminal metadata", async () => {
    const fixture = await createPendingRun();
    const ref = { projectRoot: fixture.root, canvasId: "default" };
    const audit = { decisionSource: "scheduler-alpha", reason: null };
    await expect(
      respondToRunnerInteraction(
        ref,
        fixture.identity,
        { kind: "select", optionId: "not-advertised" },
        audit,
        { now: () => now }
      )
    ).rejects.toMatchObject<RunnerInteractionApiError>({
      code: "interaction_option_not_advertised"
    });
    await writeJsonFile(join(fixture.runDir, "metadata.json"), {
      runnerKind: "acp",
      runId: "RUN-001",
      executorRunId: "RUN-001",
      ref: fixture.identity.claimRef,
      projectId: fixture.identity.projectId,
      canvasId: fixture.identity.canvasId,
      sessionId: fixture.identity.sessionId,
      ownerLeaseId: lease,
      ownerGeneration: 1,
      status: "completed",
      desktopRunId: null
    });
    await expect(
      respondToRunnerInteraction(ref, fixture.identity, { kind: "cancel" }, audit, {
        now: () => now
      })
    ).rejects.toMatchObject<RunnerInteractionApiError>({ code: "interaction_run_terminal" });
  });

  it.each([
    ["heartbeat", "{broken"],
    ["heartbeat", "{}"],
    ["metadata", "{broken"],
    ["metadata", "{}"],
    ["mailbox", "{broken"],
    ["mailbox", "{}"]
  ] as const)("rejects invalid %s JSON or schema at the list boundary", async (target, content) => {
    const fixture = await createPendingRun();
    const path =
      target === "mailbox"
        ? join(
            fixture.runDir,
            "interactions",
            Buffer.from(fixture.identity.requestId).toString("base64url"),
            "request.json"
          )
        : join(fixture.runDir, `${target}.json`);
    await writeFile(path, content, "utf8");
    await expect(
      listPendingRunnerInteractions({ projectRoot: fixture.root, canvasId: "default" })
    ).rejects.toMatchObject<RunnerInteractionApiError>({
      code: "interaction_contract_invalid"
    });
  });
});
