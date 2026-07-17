import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ActiveAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";
import { AcpSessionController, type AcpSessionRun } from "../autoRun/acpSessionController.js";
import {
  runnerPermissionInteractionResponseSchema,
  type RunnerPermissionInteractionRequest
} from "../autoRun/runnerInteractionContract.js";
import { PersistentRunnerInteractionStore } from "../autoRun/runnerInteractionStore.js";
import { readJsonFile } from "../json.js";

const acpFixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const crossProcessWorker = fileURLToPath(
  new URL("./support/acpCrossProcessPermissionWorker.ts", import.meta.url)
);

function runWorker(mode: "owner" | "responder", runDir: string) {
  const child = spawn(process.execPath, ["--import", "tsx", crossProcessWorker, mode, runDir], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `ACP ${mode} worker exited code=${String(code)} signal=${String(signal)}: ${stderr}`
          )
        );
    });
  });
  return { child, completed };
}

function run(root: string, scenario: string): AcpSessionRun {
  return {
    kind: "implementation",
    identity: {
      scope: root,
      desktopRunId: undefined,
      runSessionId: "SESSION-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001"
    },
    runDir: root,
    metadataPath: join(root, "metadata.json"),
    prompt: scenario,
    cwd: root,
    launch: { command: process.execPath, args: [acpFixture, scenario] },
    executorName: "mock-acp",
    agentId: "codex",
    taskId: "T-001",
    metadataIdentity: { blockId: "B-001" },
    projectId: "project-1",
    canvasId: "default"
  };
}

async function waitForRequest(store: PersistentRunnerInteractionStore) {
  let request: RunnerPermissionInteractionRequest | null = null;
  await vi.waitFor(
    async () => {
      const snapshots = await store.listSnapshots();
      expect(snapshots).toHaveLength(1);
      request = snapshots[0]?.request ?? null;
    },
    { timeout: 3_000, interval: 10 }
  );
  if (!request) throw new Error("Expected a persisted ACP permission request.");
  return request;
}

describe("ACP cross-process permission", () => {
  it.each([
    ["permission-secret", "token=opaque-action-id", "approved"],
    ["permission-deny", "deny", "denied"]
  ] as const)("keeps %s pending until another store selects %s", async (scenario, optionId, outcome) => {
    const root = await mkdtemp(join(tmpdir(), `planweave-acp-cross-process-${scenario}-`));
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    const execution = controller.execute(run(root, scenario), { timeoutMs: 5_000 });
    const externalStore = new PersistentRunnerInteractionStore(root);
    const request = await waitForRequest(externalStore);

    let waitingHeartbeat: Record<string, unknown> = {};
    await vi.waitFor(async () => {
      waitingHeartbeat = await readJsonFile<Record<string, unknown>>(join(root, "heartbeat.json"));
      expect(waitingHeartbeat.runnerLifecycle).toBe("waiting_interaction");
    });
    expect(waitingHeartbeat).toMatchObject({
      ownerLeaseId: request.identity.ownerLeaseId,
      ownerGeneration: 1,
      runnerLifecycle: "waiting_interaction",
      pendingInteractionIds: [request.identity.requestId]
    });
    expect(request.identity).toMatchObject({
      projectId: "project-1",
      canvasId: "default",
      claimRef: "T-001#B-001",
      executorRunId: "RUN-001",
      sessionId: "mock-session-1"
    });
    await expect(
      readJsonFile<Record<string, unknown>>(join(root, "metadata.json"))
    ).resolves.toMatchObject({ projectId: "project-1", canvasId: "default" });

    await externalStore.createResponse(
      runnerPermissionInteractionResponseSchema.parse({
        version: "planweave.runner-interaction-response/v1",
        identity: request.identity,
        decision: { kind: "select", optionId },
        respondedAt: new Date().toISOString(),
        decisionSource: "external-coordinator",
        reason: null
      })
    );

    await expect(execution).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    const protocol = await readFile(join(root, "protocol.ndjson"), "utf8");
    expect(protocol.match(/\"method\":\"session\/prompt\"/g)).toHaveLength(1);
    expect(protocol).toContain(`\"optionId\":\"${optionId}\"`);
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    const pendingIndex = events.indexOf('"status":"pending"');
    const resultIndex = events.indexOf(`"outcome":"${outcome}"`);
    expect(pendingIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(pendingIndex);
    const heartbeat = await readJsonFile<Record<string, unknown>>(join(root, "heartbeat.json"));
    expect(heartbeat).toMatchObject({
      status: "completed",
      runnerLifecycle: "terminal",
      pendingInteractionIds: []
    });
  });

  it("keeps a Desktop broker as an optional response accelerator", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-desktop-broker-"));
    const available = vi.fn(async (request) => {
      if (request.kind === "permission") await request.respond("token=opaque-action-id");
    });
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    await expect(
      controller.execute(run(root, "permission-secret"), {
        timeoutMs: 5_000,
        interactionBroker: { mode: "interactive", requestAvailable: available }
      })
    ).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    expect(available).toHaveBeenCalledTimes(1);
  });

  it("expires an owner-aborted request without creating a client response", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-owner-abort-"));
    const abortController = new AbortController();
    const controller = new AcpSessionController(new ActiveAgentRunRegistry());
    const execution = controller.execute(run(root, "permission-secret"), {
      timeoutMs: 5_000,
      signal: abortController.signal
    });
    const store = new PersistentRunnerInteractionStore(root);
    const request = await waitForRequest(store);
    await vi.waitFor(async () => {
      const heartbeat = await readJsonFile<Record<string, unknown>>(join(root, "heartbeat.json"));
      expect(heartbeat.runnerLifecycle).toBe("waiting_interaction");
    });
    abortController.abort(new Error("owner stopped"));
    await expect(execution).rejects.toThrow("owner stopped");
    await expect(store.readSnapshot("permission:1")).resolves.toMatchObject({
      status: "expired",
      response: null,
      ownerResult: { outcome: "expired" }
    });
    await expect(
      store.createResponse(
        runnerPermissionInteractionResponseSchema.parse({
          version: "planweave.runner-interaction-response/v1",
          identity: request.identity,
          decision: { kind: "select", optionId: "token=opaque-action-id" },
          respondedAt: new Date().toISOString(),
          decisionSource: "late-client",
          reason: null
        })
      )
    ).rejects.toMatchObject({
      code: "interaction_already_answered",
      details: { winnerKind: "owner_result" }
    });
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events).toContain('"outcome":"expired"');
    expect(events).not.toContain('"decisionSource":"planweave-desktop"');
    const heartbeat = await readJsonFile<Record<string, unknown>>(join(root, "heartbeat.json"));
    expect(heartbeat).toMatchObject({
      runnerLifecycle: "terminal",
      pendingInteractionIds: []
    });
  });

  it("resumes the same ACP session when a second real process responds", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-real-cross-process-"));
    const owner = runWorker("owner", root);
    const responder = runWorker("responder", root);
    const [ownerResult, responderResult] = await Promise.all([
      owner.completed,
      responder.completed
    ]);
    expect(ownerResult.stdout).toContain('"kind":"owner_completed"');
    expect(responderResult.stdout).toContain('"kind":"response_created"');
    expect(responderResult.stdout).toContain('"sessionId":"mock-session-1"');

    const store = new PersistentRunnerInteractionStore(root);
    await expect(store.readSnapshot("permission:1")).resolves.toMatchObject({
      status: "answered",
      ownerResult: null,
      response: { decisionSource: "child-process-responder" }
    });
    const protocol = await readFile(join(root, "protocol.ndjson"), "utf8");
    expect(protocol.match(/"method":"session\/prompt"/g)).toHaveLength(1);
    expect(protocol).toContain('"optionId":"token=opaque-action-id"');
    const heartbeat = await readJsonFile<Record<string, unknown>>(join(root, "heartbeat.json"));
    expect(heartbeat).toMatchObject({
      status: "completed",
      runnerLifecycle: "terminal",
      pendingInteractionIds: []
    });
    expect(owner.child.exitCode).toBe(0);
    expect(responder.child.exitCode).toBe(0);
  }, 15_000);
});
