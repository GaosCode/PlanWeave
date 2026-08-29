import { describe, expect, it } from "vitest";
import {
  canvasRuntimeAvailabilitySchema,
  canvasRuntimeAvailabilityV1Schema,
  canvasRuntimeAvailabilityV2Schema,
  canvasRuntimeExecutionAvailabilitySchema
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
  it("keeps authoritative state in v2 when the execution device is unavailable", () => {
    const parsed = canvasRuntimeAvailabilityV2Schema.parse({
      schemaVersion: "canvas-runtime-view/v2",
      authority: {
        revision: 7,
        sourceRevision: `snapshot:${"b".repeat(64)}`,
        graphFingerprint: fingerprint
      },
      state: { kind: "initialized", runtimeRevision: 1, status },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "host_offline",
        hostId: "host-1",
        lastSeenAt: "2026-08-20T00:00:00.000Z"
      }
    });

    expect(parsed.state).toMatchObject({ kind: "initialized", runtimeRevision: 1 });
    expect(parsed.authority).toMatchObject({ revision: 7, graphFingerprint: fingerprint });
    expect(parsed.execution.kind).toBe("unavailable");
  });

  it("keeps the legacy v1 shape exact and authority-free", () => {
    expect(
      canvasRuntimeAvailabilityV1Schema.parse({
        schemaVersion: "canvas-runtime-view/v1",
        state: { kind: "uninitialized" },
        execution: {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "runtime_not_attached"
        }
      })
    ).toMatchObject({ state: { kind: "uninitialized" } });
    expect(
      canvasRuntimeAvailabilityV1Schema.safeParse({
        schemaVersion: "canvas-runtime-view/v1",
        authority: {
          revision: 7,
          sourceRevision: `snapshot:${"b".repeat(64)}`,
          graphFingerprint: fingerprint
        },
        state: { kind: "uninitialized" },
        execution: {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "runtime_not_attached"
        }
      }).success
    ).toBe(false);
  });

  it("requires authority in v2 while the compatibility parser accepts v1 and v2", () => {
    const legacy = {
      schemaVersion: "canvas-runtime-view/v1" as const,
      state: { kind: "uninitialized" as const },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1" as const,
        kind: "unavailable" as const,
        reason: "runtime_not_attached" as const
      }
    };
    expect(canvasRuntimeAvailabilitySchema.parse(legacy)).toEqual(legacy);
    expect(
      canvasRuntimeAvailabilityV2Schema.safeParse({
        ...legacy,
        schemaVersion: "canvas-runtime-view/v2"
      }).success
    ).toBe(false);
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
