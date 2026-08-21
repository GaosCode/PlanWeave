import { describe, expect, it } from "vitest";
import {
  canvasRuntimeAvailabilitySchema,
  canvasRuntimeExecutionAvailabilitySchema,
  importCanvasRuntimeStatusRequestSchema
} from "../runtimeAvailability.js";

const fingerprint = `pkg-${"a".repeat(64)}`;
const status = {
  schemaVersion: "canvas-runtime-status/v2" as const,
  scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" },
  packageFingerprint: fingerprint,
  capturedAt: "2026-08-20T00:00:00.000Z",
  tasks: [{ taskId: "T-001", status: "implemented" as const, openFeedbackCount: 0 }],
  blocks: [
    {
      ref: "T-001#B-001",
      status: "completed" as const,
      completionReason: "passed" as const,
      blockedReason: null,
      divergenceReason: null,
      dispatchable: false
    }
  ]
};

describe("canvas runtime availability", () => {
  it("keeps authoritative state when the execution device is unavailable", () => {
    const parsed = canvasRuntimeAvailabilitySchema.parse({
      schemaVersion: "canvas-runtime-view/v1",
      state: { kind: "initialized", status },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "host_offline",
        hostId: "host-1",
        lastSeenAt: "2026-08-20T00:00:00.000Z"
      }
    });

    expect(parsed.state.kind).toBe("initialized");
    expect(parsed.execution.kind).toBe("unavailable");
  });

  it("represents a legacy canvas whose Server state has not been imported", () => {
    expect(
      canvasRuntimeAvailabilitySchema.parse({
        schemaVersion: "canvas-runtime-view/v1",
        state: { kind: "uninitialized" },
        execution: {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "runtime_not_attached"
        }
      })
    ).toMatchObject({ state: { kind: "uninitialized" } });
  });

  it("keeps Host execution evidence in a separate strict contract", () => {
    expect(
      canvasRuntimeExecutionAvailabilitySchema.parse({
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "available",
        status,
        sourceRevision: "src-revision-001",
        graphFingerprint: fingerprint
      })
    ).toMatchObject({ kind: "available", graphFingerprint: fingerprint });
  });

  it("accepts a strict first-import request and rejects path leakage", () => {
    expect(importCanvasRuntimeStatusRequestSchema.parse({ status })).toEqual({ status });
    expect(
      importCanvasRuntimeStatusRequestSchema.safeParse({ status, projectRoot: "/private/project" })
        .success
    ).toBe(false);
  });

  it("rejects an execution-only payload as the shared Runtime view", () => {
    expect(
      canvasRuntimeAvailabilitySchema.safeParse({
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "runtime_not_attached"
      }).success
    ).toBe(false);
  });
});
