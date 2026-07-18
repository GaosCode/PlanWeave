import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import type { ActiveAgentRunHandle } from "../../autoRun/activeAgentRunRegistry.js";
import { createLiveOwnership } from "../../autoRun/liveControl.js";
import { normalizedRunnerEventSchema } from "../../autoRun/normalizedEventContract.js";
import { PersistentRunnerInteractionStore } from "../../autoRun/runnerInteractionStore.js";
import { writeJsonFile } from "../../json.js";

const metadata = {
  runnerKind: "acp",
  runId: "RUN-001",
  ref: "T-001#B-001",
  taskId: "T-001",
  blockId: "B-001",
  executorRunId: "RUN-001",
  sessionId: "session-1"
};

const ownerLeaseId = "11111111-1111-4111-8111-111111111111";
const mailboxMetadata = {
  ...metadata,
  projectId: "project-1",
  canvasId: "default",
  ownerLeaseId,
  ownerGeneration: 1,
  status: "running"
};

async function createMailbox(runDir: string, lastHeartbeatAt: string): Promise<void> {
  await chmod(runDir, 0o700);
  await new PersistentRunnerInteractionStore(runDir).createRequest({
    version: "planweave.runner-interaction/v1",
    kind: "permission",
    identity: {
      projectId: "project-1",
      canvasId: "default",
      claimRef: "T-001#B-001",
      executorRunId: "RUN-001",
      sessionId: "session-1",
      requestId: "permission-1",
      ownerLeaseId,
      ownerGeneration: 1
    },
    requestedAt: "2026-07-11T00:00:00.000Z",
    summary: "approval required",
    toolCallId: "tool-1",
    options: [{ optionId: "allow", label: "Allow", decision: "approve" }]
  });
  await writeJsonFile(join(runDir, "heartbeat.json"), {
    status: "running",
    pid: null,
    startedAt: "2026-07-11T00:00:00.000Z",
    lastHeartbeatAt,
    finishedAt: null,
    ownerLeaseId,
    ownerGeneration: 1,
    runnerLifecycle: "waiting_interaction",
    pendingInteractionIds: ["permission-1"]
  });
}

function activeHandle(
  runDir: string,
  ownerIds: { desktopRunId?: string; runSessionId?: string } = {
    desktopRunId: "DESKTOP-001",
    runSessionId: "SESSION-001"
  }
): ActiveAgentRunHandle {
  const ownership = createLiveOwnership(`${runDir}:RUN-001`, 1);
  const pendingRequests = new Map([
    [
      "permission-1",
      {
        requestId: "permission-1",
        interactionId: "permission-1",
        kind: "permission" as const,
        requestedAt: "2026-07-11T00:00:00.000Z",
        summary: "approval required",
        permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" as const }],
        respond: vi.fn(async () => undefined),
        reject: vi.fn(async () => undefined)
      }
    ]
  ]);
  return {
    identity: {
      scope: runDir,
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001",
      sessionId: "session-1",
      ...ownerIds
    },
    connection: {
      processId: null,
      pendingOperationCount: 0,
      pendingOperations: new Map(),
      stderr: [],
      closed: Promise.resolve(),
      initialize: vi.fn(),
      newSession: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(async () => undefined),
      closeSession: vi.fn(),
      dispose: vi.fn(async () => undefined)
    },
    abortController: new AbortController(),
    eventSink: () => undefined,
    ownership,
    lifecycleState: "waiting_interaction",
    control: {
      ownership,
      process: { pid: null, terminate: vi.fn(async () => undefined) },
      connection: {
        send: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        cancelSession: vi.fn(async () => undefined),
        closeSession: vi.fn(async () => undefined),
        supportsSessionClose: false
      },
      sessionId: "session-1",
      interventionCapabilities: { cancel: true, permission: true, elicitationPreview: true },
      pendingRequests,
      pendingOperations: new Map()
    }
  };
}

function event(
  sequence: number,
  kind: "interaction" | "terminal" | "message",
  claimRef = "T-001#B-001",
  ownerIds: { desktopRunId?: string | null; runSessionId?: string | null } = {}
) {
  const [taskId, blockId] = claimRef.split("#");
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence,
    timestamp: "2026-07-11T00:00:00.000Z",
    identity: {
      projectId: "project-1",
      canvasId: "default",
      taskId,
      blockId,
      claimRef,
      runId: "RUN-001",
      runOwner: "executor",
      runSessionId: ownerIds.runSessionId === undefined ? "SESSION-001" : ownerIds.runSessionId,
      desktopRunId: ownerIds.desktopRunId === undefined ? "DESKTOP-001" : ownerIds.desktopRunId,
      executorRunId: "RUN-001"
    },
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    correlation: { sessionId: "session-1" },
    body:
      kind === "interaction"
        ? {
            kind: "interaction",
            interaction: {
              version: "planweave.runner/v1",
              interactionId: "permission-1",
              requestId: "permission-1",
              kind: "permission",
              requestedAt: "2026-07-11T00:00:00.000Z",
              summary: "approval required",
              status: "cancelled",
              actionable: false,
              nonActionableReason: "terminal_cleanup"
            }
          }
        : kind === "terminal"
          ? {
              kind: "terminal",
              outcome: {
                version: "planweave.runner/v1",
                state: "succeeded",
                exitCode: 0,
                finishedAt: "2026-07-11T00:00:01.000Z",
                diagnostic: null,
                artifactValidated: true
              }
            }
          : {
              kind: "message",
              role: "assistant",
              messageId: `message-${sequence}`,
              chunk: true,
              content: `message ${sequence}`,
              redaction: { classes: [], replaced: 0 }
            }
  });
}

export { activeHandle, createMailbox, event, mailboxMetadata, metadata, ownerLeaseId };
