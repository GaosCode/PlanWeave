import { describe, expect, it } from "vitest";
import {
  isRunnerRecordLiveActionIdentity,
  runnerPersistedInteractionAvailabilitySchema
} from "../autoRun/runnerRecordReadModelContract.js";

describe("runner record read model contract", () => {
  it("rejects unknown persisted permission availability reasons", () => {
    expect(
      runnerPersistedInteractionAvailabilitySchema.safeParse({
        available: false,
        reason: "arbitrary_live_registry_message"
      }).success
    ).toBe(false);
  });

  it("distinguishes live bridge identities from persisted mailbox identities", () => {
    expect(
      isRunnerRecordLiveActionIdentity({
        scope: "/projects/demo",
        executorRunId: "RUN-001",
        desktopRunId: "DESKTOP-001",
        runSessionId: "RUN-SESSION-001",
        claimRef: "T-001#B-001",
        sessionId: "ACP-SESSION-001",
        requestId: "permission-1"
      })
    ).toBe(true);
    expect(
      isRunnerRecordLiveActionIdentity({
        projectId: "project-1",
        canvasId: "default",
        claimRef: "T-001#B-001",
        executorRunId: "RUN-001",
        sessionId: "ACP-SESSION-001",
        requestId: "permission-1",
        ownerLeaseId: "11111111-1111-4111-8111-111111111111",
        ownerGeneration: 1
      })
    ).toBe(false);
  });
});
