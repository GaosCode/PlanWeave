import { describe, expect, it } from "vitest";
import { normalizedRunnerEventSchema } from "../autoRun/normalizedEventContract.js";
import {
  projectAcpConversation,
  projectAcpTimeline
} from "../autoRun/acpConversationProjection.js";

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
      runner: {
        version: "planweave.runner/v1" as const,
        runnerKind: "acp" as const,
        agentId: "codex" as const
      }
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

  it("applies tool updates as replacement state in one renderer-owned timeline item", () => {
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
      runner: {
        version: "planweave.runner/v1" as const,
        runnerKind: "acp" as const,
        agentId: "codex" as const
      }
    };
    const events = [
      normalizedRunnerEventSchema.parse({
        ...base,
        sequence: 1,
        body: {
          kind: "tool_call",
          callId: "tool-1",
          title: "Read file",
          status: "in_progress",
          toolKind: "read",
          content: null,
          rawInput: { content: "README.md", redaction: { classes: [], replaced: 0 } },
          rawOutput: null
        }
      }),
      normalizedRunnerEventSchema.parse({
        ...base,
        sequence: 2,
        body: {
          kind: "tool_update",
          callId: "tool-1",
          status: "in_progress",
          title: "Reading README",
          content: { content: "part one", redaction: { classes: [], replaced: 0 } }
        }
      }),
      normalizedRunnerEventSchema.parse({
        ...base,
        sequence: 3,
        body: {
          kind: "tool_update",
          callId: "tool-1",
          status: "completed",
          content: { content: " + part two", redaction: { classes: [], replaced: 0 } }
        }
      })
    ];

    expect(projectAcpTimeline(events)).toEqual([
      {
        sequence: 1,
        timestamp: base.timestamp,
        kind: "tool",
        callId: "tool-1",
        title: "Reading README",
        toolKind: "read",
        status: "completed",
        input: "README.md",
        output: " + part two"
      }
    ]);
  });

  it("distinguishes absent tool content from explicit null replacement", () => {
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
      runner: {
        version: "planweave.runner/v1" as const,
        runnerKind: "acp" as const,
        agentId: "codex" as const
      }
    };
    const redaction = { classes: [], replaced: 0 } as const;
    const call = normalizedRunnerEventSchema.parse({
      ...base,
      sequence: 1,
      body: {
        kind: "tool_call",
        callId: "tool-1",
        title: "Run",
        status: "in_progress",
        content: null,
        rawOutput: { content: "initial", redaction }
      }
    });
    const absent = normalizedRunnerEventSchema.parse({
      ...base,
      sequence: 2,
      body: {
        kind: "tool_update",
        callId: "tool-1",
        status: "completed"
      }
    });
    const cleared = normalizedRunnerEventSchema.parse({
      ...base,
      sequence: 3,
      body: {
        kind: "tool_update",
        callId: "tool-1",
        content: null
      }
    });

    expect(projectAcpTimeline([call, absent])[0]).toMatchObject({ output: "initial" });
    expect(projectAcpTimeline([call, absent, cleared])[0]).toMatchObject({ output: null });
  });

  it("keeps an artifact at its normalized event position in the timeline", () => {
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
      runner: {
        version: "planweave.runner/v1" as const,
        runnerKind: "acp" as const,
        agentId: "codex" as const
      }
    };
    const message = (sequence: number, content: string) =>
      normalizedRunnerEventSchema.parse({
        ...base,
        sequence,
        body: {
          kind: "message",
          role: "assistant",
          messageId: `message-${sequence}`,
          chunk: false,
          content,
          redaction: { classes: [], replaced: 0 }
        }
      });
    const artifact = normalizedRunnerEventSchema.parse({
      ...base,
      sequence: 2,
      body: {
        kind: "artifact",
        artifact: {
          version: "planweave.runner/v1",
          kind: "implementation",
          relativePath: "report.md",
          sha256: "a".repeat(64),
          sizeBytes: 310,
          mediaType: "text/markdown"
        }
      }
    });

    expect(
      projectAcpTimeline([message(1, "First turn"), artifact, message(3, "Follow-up turn")])
    ).toEqual([
      expect.objectContaining({ sequence: 1, kind: "message", content: "First turn" }),
      expect.objectContaining({ sequence: 2, kind: "artifact", artifact: artifact.body.artifact }),
      expect.objectContaining({ sequence: 3, kind: "message", content: "Follow-up turn" })
    ]);
  });

  it("coalesces an out-of-order tool update with its later tool call", () => {
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
      runner: {
        version: "planweave.runner/v1" as const,
        runnerKind: "acp" as const,
        agentId: "codex" as const
      }
    };
    const redaction = { classes: [], replaced: 0 } as const;
    const timeline = projectAcpTimeline([
      normalizedRunnerEventSchema.parse({
        ...base,
        sequence: 1,
        body: {
          kind: "tool_update",
          callId: "tool-1",
          title: "Updated title",
          status: "completed",
          rawOutput: { content: "done", redaction }
        }
      }),
      normalizedRunnerEventSchema.parse({
        ...base,
        sequence: 2,
        body: {
          kind: "tool_call",
          callId: "tool-1",
          title: "Initial title",
          toolKind: "execute",
          status: "in_progress",
          content: null,
          rawInput: { content: '{"command":"pwd"}', redaction }
        }
      })
    ]);

    expect(timeline).toEqual([
      expect.objectContaining({
        sequence: 1,
        callId: "tool-1",
        title: "Updated title",
        toolKind: "execute",
        status: "completed",
        input: '{"command":"pwd"}',
        output: "done"
      })
    ]);
  });

  it("projects a large chunk stream into one message without quadratic output growth", () => {
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
      runner: {
        version: "planweave.runner/v1" as const,
        runnerKind: "acp" as const,
        agentId: "codex" as const
      }
    };
    const events = Array.from({ length: 2_000 }, (_, index) =>
      normalizedRunnerEventSchema.parse({
        ...base,
        sequence: index + 1,
        body: {
          kind: "message",
          role: "assistant",
          messageId: "message-1",
          chunk: true,
          content: "x",
          redaction: { classes: [], replaced: 0 }
        }
      })
    );

    const timeline = projectAcpTimeline(events);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "message", content: "x".repeat(2_000) });
  });
});
