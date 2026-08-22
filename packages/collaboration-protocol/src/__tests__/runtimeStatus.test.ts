import { describe, expect, it } from "vitest";
import { canvasRuntimeStatusProjectionSchema } from "../runtimeStatus.js";
import {
  canvasRuntimeResetRequestSchema,
  canvasRuntimeResetOutcomeSchema
} from "../runtimeControl.js";

describe("canvas runtime status projection", () => {
  it("accepts only the redacted task and block execution state needed by replicas", () => {
    const parsed = canvasRuntimeStatusProjectionSchema.parse({
      schemaVersion: "canvas-runtime-status/v2",
      scope: {
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default"
      },
      packageFingerprint: `pkg-${"a".repeat(64)}`,
      capturedAt: "2026-08-01T00:00:00.000Z",
      tasks: [{ taskId: "T-001", status: "implemented", openFeedbackCount: 0 }],
      blocks: [
        {
          ref: "T-001#B-001",
          status: "completed",
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: false
        }
      ]
    });

    expect(parsed.tasks[0]?.status).toBe("implemented");
    expect(parsed.blocks[0]).not.toHaveProperty("lastRunId");
    expect(parsed.blocks[0]).not.toHaveProperty("remoteOwnership");
  });

  it("rejects duplicate task and block identities", () => {
    const base = {
      schemaVersion: "canvas-runtime-status/v2" as const,
      scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" },
      packageFingerprint: `pkg-${"a".repeat(64)}`,
      capturedAt: "2026-08-01T00:00:00.000Z"
    };
    expect(() =>
      canvasRuntimeStatusProjectionSchema.parse({
        ...base,
        tasks: [
          { taskId: "T-001", status: "ready", openFeedbackCount: 0 },
          { taskId: "T-001", status: "implemented", openFeedbackCount: 0 }
        ],
        blocks: []
      })
    ).toThrow();
    expect(() =>
      canvasRuntimeStatusProjectionSchema.parse({
        ...base,
        tasks: [],
        blocks: [
          {
            ref: "T-001#B-001",
            status: "ready",
            completionReason: null,
            blockedReason: null,
            divergenceReason: null,
            dispatchable: true
          },
          {
            ref: "T-001#B-001",
            status: "completed",
            completionReason: null,
            blockedReason: null,
            divergenceReason: null,
            dispatchable: false
          }
        ]
      })
    ).toThrow();
  });
});

describe("canvas runtime reset control", () => {
  it("requires operation identity, expected evidence, and a structured outcome", () => {
    const fingerprint = `pkg-${"a".repeat(64)}`;
    const request = {
      operationId: "reset-1",
      expectedContentRevision: 4,
      expectedSourceRevision: `snapshot:${"b".repeat(64)}`,
      expectedGraphFingerprint: fingerprint
    };
    expect(canvasRuntimeResetRequestSchema.parse(request)).toEqual(request);
    expect(
      canvasRuntimeResetOutcomeSchema.parse({
        type: "canvas.runtime.reset.accepted",
        operationId: "reset-1",
        runtimeRevision: 2,
        sourceRevision: request.expectedSourceRevision,
        graphFingerprint: fingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" },
          packageFingerprint: fingerprint,
          capturedAt: "2026-08-01T00:00:00.000Z",
          tasks: [],
          blocks: []
        }
      })
    ).toMatchObject({ runtimeRevision: 2, operationId: "reset-1" });
    expect(
      canvasRuntimeResetOutcomeSchema.parse({
        type: "canvas.runtime.reset.rejected",
        operationId: "reset-1",
        code: "active_lease"
      })
    ).toEqual({
      type: "canvas.runtime.reset.rejected",
      operationId: "reset-1",
      code: "active_lease"
    });
    expect(() =>
      canvasRuntimeResetOutcomeSchema.parse({
        type: "canvas.runtime.reset.accepted",
        operationId: "reset-1",
        ok: true
      })
    ).toThrow();
    expect(() => canvasRuntimeResetRequestSchema.parse({ ...request, extra: true })).toThrow();
  });
});
