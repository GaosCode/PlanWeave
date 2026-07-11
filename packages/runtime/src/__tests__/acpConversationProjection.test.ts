import { describe, expect, it } from "vitest";
import { normalizedRunnerEventSchema } from "../autoRun/normalizedEventContract.js";
import { projectAcpConversation } from "../autoRun/acpConversationProjection.js";

describe("ACP conversation projection", () => {
  it("projects renderer-safe conversation and tool items from normalized events", () => {
    const base = {
      version: "planweave.runner-event/v1" as const,
      timestamp: "2026-07-11T00:00:00.000Z",
      identity: {
        projectId: "project-1",
        canvasId: "canvas-a",
        taskId: "T-001",
        blockId: "B-001",
        claimRef: "T-001#B-001",
        runId: "RUN-001",
        runOwner: "executor" as const,
        runSessionId: null,
        desktopRunId: null,
        executorRunId: "RUN-001"
      },
      runner: { version: "planweave.runner/v1" as const, runnerKind: "acp" as const, agentId: "codex" as const }
    };
    const events = [
      normalizedRunnerEventSchema.parse({
        ...base,
        sequence: 1,
        body: {
          kind: "message",
          role: "assistant",
          messageId: "message-1",
          chunk: true,
          content: "Hello",
          redaction: { classes: [], replaced: 0 }
        }
      }),
      normalizedRunnerEventSchema.parse({
        ...base,
        sequence: 2,
        body: {
          kind: "tool_call",
          callId: "tool-1",
          title: "Read file",
          status: "in_progress",
          content: null
        }
      })
    ];

    expect(projectAcpConversation(events)).toEqual([
      expect.objectContaining({ sequence: 1, role: "assistant", content: "Hello" }),
      expect.objectContaining({ sequence: 2, kind: "tool_call", content: "Read file" })
    ]);
  });
});
