import { describe, expect, it } from "vitest";
import { canvasRuntimeAvailabilitySchema } from "../runtimeAvailability.js";

const statusPackageFingerprint = `pkg-${"a".repeat(64)}`;
const graphFingerprint = `pkg-${"b".repeat(64)}`;

const available = {
  schemaVersion: "canvas-runtime-availability/v1" as const,
  kind: "available" as const,
  status: {
    schemaVersion: "canvas-runtime-status/v2" as const,
    scope: {
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "default"
    },
    packageFingerprint: statusPackageFingerprint,
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
  },
  sourceRevision: "src-revision-001",
  graphFingerprint,
  hostId: "host-1"
};

describe("canvas runtime availability", () => {
  it("accepts available with a real runtime status and distinct source evidence", () => {
    const parsed = canvasRuntimeAvailabilitySchema.parse(available);

    expect(parsed.kind).toBe("available");
    if (parsed.kind !== "available") throw new Error("expected_available_runtime");
    expect(parsed.status.tasks[0]?.status).toBe("implemented");
    expect(parsed.status.packageFingerprint).toBe(statusPackageFingerprint);
    expect(parsed.graphFingerprint).toBe(graphFingerprint);
  });

  it.each([
    "runtime_not_attached",
    "host_offline",
    "content_out_of_sync"
  ] as const)("accepts unavailable reason %s without a synthetic status", (reason) => {
    const parsed = canvasRuntimeAvailabilitySchema.parse({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "unavailable",
      reason,
      hostId: "host-1",
      lastSeenAt: "2026-08-20T00:00:00.000Z"
    });

    expect(parsed.kind).toBe("unavailable");
    expect(parsed).not.toHaveProperty("status");
  });

  it("accepts unavailable without optional Host observation fields", () => {
    expect(
      canvasRuntimeAvailabilitySchema.parse({
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "runtime_not_attached"
      })
    ).toEqual({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "unavailable",
      reason: "runtime_not_attached"
    });
  });

  it.each([
    ["unknown reason", { kind: "unavailable", reason: "runtime_unknown" }],
    ["missing unavailable reason", { kind: "unavailable", reason: undefined }],
    ["extra field", { kind: "unavailable", reason: "host_offline", projectRoot: "/private" }],
    ["invalid timestamp", { kind: "unavailable", reason: "host_offline", lastSeenAt: "yesterday" }],
    ["invalid host id", { kind: "unavailable", reason: "host_offline", hostId: "/host/1" }]
  ])("rejects %s", (_label, overrides) => {
    expect(
      canvasRuntimeAvailabilitySchema.safeParse({
        schemaVersion: "canvas-runtime-availability/v1",
        ...overrides
      }).success
    ).toBe(false);
  });

  it.each([
    ["missing status", { status: undefined }],
    ["missing source revision", { sourceRevision: undefined }],
    ["missing graph fingerprint", { graphFingerprint: undefined }],
    ["extra field", { errorMessage: "runtime unavailable" }],
    ["source revision", { sourceRevision: "../../source" }],
    ["graph fingerprint", { graphFingerprint: "pkg-not-a-sha256" }],
    [
      "status package fingerprint",
      { status: { ...available.status, packageFingerprint: graphFingerprint.slice(4) } }
    ]
  ])("rejects an invalid available %s", (_label, overrides) => {
    expect(canvasRuntimeAvailabilitySchema.safeParse({ ...available, ...overrides }).success).toBe(
      false
    );
  });

  it("rejects fields from the opposite discriminator branch", () => {
    expect(
      canvasRuntimeAvailabilitySchema.safeParse({ ...available, reason: "host_offline" }).success
    ).toBe(false);
    expect(
      canvasRuntimeAvailabilitySchema.safeParse({
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "runtime_not_attached",
        status: available.status,
        sourceRevision: available.sourceRevision,
        graphFingerprint: available.graphFingerprint
      }).success
    ).toBe(false);
  });
});
