import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PersistentRunnerInteractionChannel } from "../../../runtime/src/autoRun/persistentRunnerInteractionChannel";
import { PersistentRunnerInteractionStore } from "../../../runtime/src/autoRun/runnerInteractionStore";
import { AgentRunControlServer } from "../../../runtime/src/autoRun/agentRunControlServer";
import { writeJsonFile } from "../../../runtime/src/json";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers";
import { createDesktopBridgeInvokeApi } from "../preload/bridgeInvocation";
import { desktopBridgeInvokeChannels } from "../shared/ipcChannels";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn() },
  shell: {}
}));

let runtimeBridgeHandlers: typeof import("../main/runtimeBridgeHandlerRegistry")["runtimeBridgeHandlers"];

beforeAll(async () => {
  ({ runtimeBridgeHandlers } = await import("../main/runtimeBridgeHandlerRegistry"));
});

describe("Desktop runner interaction file-backed integration", () => {
  it("carries a feedback permission through the bridge action CAS to owner continuation", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "feedback-runs", "RUN-001");
    const now = new Date();
    const ownerLeaseId = "11111111-1111-4111-8111-111111111111";
    const identity = {
      projectId: init.workspace.id,
      canvasId: "default",
      claimRef: "T-001#R-001",
      executorRunId: "RUN-001",
      sessionId: "session-feedback-1",
      requestId: "permission-feedback-1",
      ownerLeaseId,
      ownerGeneration: 1
    } as const;
    const ref = { projectRoot: root, canvasId: "default" };
    const action = {
      recordId: "FE-001::RUN-001",
      requestId: identity.requestId,
      ownerLeaseId
    };
    const decision = { kind: "select" as const, optionId: "allow_once" };
    const audit = { decisionSource: "planweave-desktop", reason: null };
    const desktopRunId = "AUTO-RUN-001";
    const runSessionId = "SESSION-001";
    await mkdir(runDir, { recursive: true });
    await writeJsonFile(join(runDir, "metadata.json"), {
      runnerKind: "acp",
      runId: identity.executorRunId,
      executorRunId: identity.executorRunId,
      feedbackId: "FE-001",
      ref: identity.claimRef,
      claimRef: identity.claimRef,
      projectId: identity.projectId,
      canvasId: identity.canvasId,
      sessionId: identity.sessionId,
      ownerLeaseId,
      ownerGeneration: 1,
      status: "running",
      desktopRunId,
      runSessionId
    });
    const writeHeartbeat = async (waiting: boolean) =>
      writeJsonFile(join(runDir, "heartbeat.json"), {
        status: "running",
        pid: null,
        startedAt: now.toISOString(),
        lastHeartbeatAt: now.toISOString(),
        finishedAt: null,
        ownerLeaseId,
        ownerGeneration: 1,
        runnerLifecycle: waiting ? "waiting_interaction" : "running",
        pendingInteractionIds: waiting ? [identity.requestId] : []
      });
    await writeHeartbeat(false);

    const store = new PersistentRunnerInteractionStore(runDir);
    const channel = new PersistentRunnerInteractionChannel({
      store,
      publishPending: async () => undefined,
      publishResult: async () => undefined,
      setWaiting: async (_requestId, waiting) => writeHeartbeat(waiting),
      pollIntervalMs: 5
    });
    const abortController = new AbortController();
    const ownerContinuation = channel.requestPermission(
      {
        version: "planweave.runner-interaction/v1",
        kind: "permission",
        identity,
        requestedAt: now.toISOString(),
        summary: "Allow feedback verification?",
        toolCallId: "tool-feedback-1",
        options: [{ optionId: "allow_once", label: "Allow once", decision: "approve" }]
      },
      { signal: abortController.signal, deadline: new Date(now.getTime() + 5_000) }
    );
    const controlServer = new AgentRunControlServer({
      runDir,
      leaseId: ownerLeaseId,
      target: {
        cancel: async () => ({ status: "delivered", deliveredAt: new Date().toISOString() }),
        followUp: async () => ({ status: "accepted" }),
        respond: async (requestIdentity, outcome) => {
          expect(requestIdentity).toMatchObject({
            scope: runDir,
            desktopRunId,
            runSessionId,
            requestId: identity.requestId
          });
          expect(outcome).toEqual(decision);
          await store.createResponse({
            version: "planweave.runner-interaction-response/v1",
            identity,
            decision,
            respondedAt: new Date().toISOString(),
            decisionSource: audit.decisionSource,
            reason: audit.reason
          });
          return { status: "delivered", deliveredAt: new Date().toISOString() };
        }
      }
    });
    await controlServer.start();

    const bridge = createDesktopBridgeInvokeApi(async (channelName, ...args) => {
      if (channelName === desktopBridgeInvokeChannels.listPendingRunnerInteractions) {
        expect(args).toEqual([ref]);
        return runtimeBridgeHandlers.listPendingRunnerInteractions(undefined!, ref);
      }
      if (channelName === desktopBridgeInvokeChannels.respondToRunnerInteraction) {
        expect(args).toEqual([ref, action, decision, audit]);
        return runtimeBridgeHandlers.respondToRunnerInteraction(
          undefined!,
          ref,
          action,
          decision,
          audit
        );
      }
      throw new Error(`Unexpected Desktop bridge channel '${channelName}'.`);
    });

    try {
      let listed = await bridge.listPendingRunnerInteractions(ref);
      for (let attempt = 0; attempt < 100 && listed.ok && listed.value.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        listed = await bridge.listPendingRunnerInteractions(ref);
      }
      expect(listed).toMatchObject({
        ok: true,
        value: [{ request: { identity } }]
      });

      await expect(
        bridge.respondToRunnerInteraction(ref, action, decision, audit)
      ).resolves.toMatchObject({ ok: true, value: { selectedOption: { decision: "approve" } } });
      await expect(
        bridge.respondToRunnerInteraction(ref, action, decision, audit)
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "interaction_already_answered" }
      });
      await expect(ownerContinuation).resolves.toEqual({
        kind: "select",
        option: { optionId: "allow_once", label: "Allow once", decision: "approve" }
      });
    } finally {
      abortController.abort();
      await ownerContinuation.catch(() => undefined);
      await controlServer.stop();
    }
  });
});
