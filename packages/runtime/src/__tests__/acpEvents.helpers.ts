import {
  normalizedRunnerEventSchema,
  type NormalizedRunnerEvent
} from "../autoRun/normalizedEventContract.js";
import { runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";

export function identity(runId = "RUN-001") {
  return runnerRunIdentitySchema.parse({
    projectId: "project-1",
    canvasId: "default",
    taskId: "T-004",
    blockId: "B-001",
    claimRef: "T-004#B-001",
    runId,
    runOwner: "executor",
    runSessionId: null,
    desktopRunId: null,
    executorRunId: runId
  });
}

export function event(sequence: number, runId = "RUN-001"): NormalizedRunnerEvent {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence,
    timestamp: "2026-07-11T00:00:00.000Z",
    identity: identity(runId),
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    correlation: { sessionId: "session-1" },
    body: { kind: "lifecycle", state: "running", message: `event ${sequence}` }
  });
}

export function projectionEvent(
  sequence: number,
  body: NormalizedRunnerEvent["body"]
): NormalizedRunnerEvent {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence,
    timestamp: `2026-07-11T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    identity: identity(),
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    correlation: { sessionId: "session-1" },
    body
  });
}
