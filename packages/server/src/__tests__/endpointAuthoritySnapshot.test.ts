import { describe, expect, it } from "vitest";
import {
  endpointSelectionSnapshotSchema,
  legacyEndpointSelectionSnapshotSchema,
  mapEndpointAuthorityToRuntimeSnapshot,
  persistEndpointSelectionSnapshot,
  readEndpointSelectionSnapshot,
  runtimeAuthoritySnapshotForTarget,
  runtimeControlPlane,
  toHumanEndpointSnapshot,
  writeEndpointSelectionSnapshotSchema
} from "../endpointSelection.js";

const selectionBase = {
  schemaVersion: "endpoint-selection/v1" as const,
  endpointId: "aep-primary",
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Codex",
  hostId: "host-internal",
  hostDisplayName: "VPS Singapore",
  capabilities: ["linux", "acp.codex"],
  resolvedAt: "2030-01-01T00:00:00.000Z"
};

const v1Collaboration = {
  ...selectionBase,
  authority: {
    schemaVersion: "endpoint-authority/v1" as const,
    controlPlane: "collaboration" as const,
    responsibilityRevision: 2,
    reviewerRevision: 3
  }
};

const v1Owner = {
  ...selectionBase,
  authority: {
    schemaVersion: "endpoint-authority/v1" as const,
    controlPlane: "owner" as const,
    responsibilityRevision: 4,
    reviewerRevision: 5
  }
};

const v2Workspace = {
  ...selectionBase,
  authority: {
    schemaVersion: "endpoint-authority/v2" as const,
    kind: "workspace_canvas" as const,
    workspaceId: "workspace-a",
    responsibilityRevision: 2,
    reviewerRevision: 3,
    executionTargetRevision: 6
  }
};

const v2Owner = {
  ...selectionBase,
  authority: {
    schemaVersion: "endpoint-authority/v2" as const,
    kind: "owner_canvas" as const,
    responsibilityRevision: 4,
    reviewerRevision: 5,
    executionTargetRevision: 7
  }
};

describe("endpoint-authority snapshot", () => {
  it("isolates legacy reads from strict current endpoint selections", () => {
    expect(legacyEndpointSelectionSnapshotSchema.parse(v1Collaboration)).toEqual(v1Collaboration);
    expect(legacyEndpointSelectionSnapshotSchema.parse(v1Owner)).toEqual(v1Owner);
    expect(endpointSelectionSnapshotSchema.parse(v2Workspace)).toEqual(v2Workspace);
    expect(endpointSelectionSnapshotSchema.parse(v2Owner)).toEqual(v2Owner);
    expect(() => endpointSelectionSnapshotSchema.parse(v1Collaboration)).toThrow();
  });

  it("fails closed when a legacy read enters current authorization", () => {
    expect(() => mapEndpointAuthorityToRuntimeSnapshot(v1Owner.authority, "workspace-a")).toThrow(
      "endpoint_authority_execution_target_revision_missing"
    );
    expect(() => readEndpointSelectionSnapshot(v1Collaboration, "workspace-a")).toThrow(
      "endpoint_authority_execution_target_revision_missing"
    );
    expect(readEndpointSelectionSnapshot(v2Workspace, "workspace-a")).toEqual(v2Workspace);
  });

  it("persists v2 only and rejects a workspace_canvas snapshot without workspaceId", () => {
    expect(() => persistEndpointSelectionSnapshot(v1Collaboration, "workspace-a")).toThrow();
    expect(persistEndpointSelectionSnapshot(v2Owner, "workspace-a")).toEqual(v2Owner);
    expect(writeEndpointSelectionSnapshotSchema.parse(v2Workspace)).toEqual(v2Workspace);
    expect(() => writeEndpointSelectionSnapshotSchema.parse(v1Collaboration)).toThrow();
    expect(() =>
      writeEndpointSelectionSnapshotSchema.parse({
        ...selectionBase,
        authority: {
          schemaVersion: "endpoint-authority/v2",
          kind: "workspace_canvas",
          responsibilityRevision: 1,
          reviewerRevision: 0
        }
      })
    ).toThrow();
  });

  it("reads historical v2 metadata without inventing authority for a new execution", () => {
    const { executionTargetRevision: _revision, ...authority } = v2Workspace.authority;
    const historical = { ...v2Workspace, authority };
    const read = readEndpointSelectionSnapshot(historical, "workspace-a");
    expect(read).toEqual(historical);
    expect(read.authority).not.toHaveProperty("executionTargetRevision");
    expect(toHumanEndpointSnapshot(read).displayName).toBe("Codex");
    expect(() => mapEndpointAuthorityToRuntimeSnapshot(read.authority, "workspace-a")).toThrow();
    expect(() => persistEndpointSelectionSnapshot(read, "workspace-a")).toThrow();
    expect(() => readEndpointSelectionSnapshot(historical, "workspace-b")).toThrow(
      "endpoint_authority_workspace_mismatch"
    );
  });

  it("builds runtime snapshots from dispatch targets and maps them back to claim controlPlane", () => {
    expect(
      runtimeAuthoritySnapshotForTarget(
        { kind: "owner_canvas" },
        { responsibilityRevision: 1, reviewerRevision: 2, executionTargetRevision: 3 }
      )
    ).toEqual({
      schemaVersion: "endpoint-authority/v2",
      kind: "owner_canvas",
      responsibilityRevision: 1,
      reviewerRevision: 2,
      executionTargetRevision: 3
    });
    expect(
      runtimeAuthoritySnapshotForTarget(
        { kind: "workspace_canvas", workspaceId: "workspace-a" },
        { responsibilityRevision: 1, reviewerRevision: 2, executionTargetRevision: 3 }
      )
    ).toEqual({
      schemaVersion: "endpoint-authority/v2",
      kind: "workspace_canvas",
      workspaceId: "workspace-a",
      responsibilityRevision: 1,
      reviewerRevision: 2,
      executionTargetRevision: 3
    });
    expect(runtimeControlPlane(v2Owner.authority)).toBe("owner");
    expect(runtimeControlPlane(v2Workspace.authority)).toBe("collaboration");
    expect(runtimeControlPlane(undefined)).toBe("collaboration");
  });

  it("does not leak hostId or authority internals through the human endpoint projection", () => {
    const human = toHumanEndpointSnapshot(v2Workspace);
    expect(human).toEqual({
      schemaVersion: "agent-endpoint/v1",
      endpointId: "aep-primary",
      profileId: "codex-acp",
      agentId: "codex",
      displayName: "Codex",
      hostDisplayName: "VPS Singapore",
      capabilities: ["linux", "acp.codex"],
      status: "available",
      resolvedAt: "2030-01-01T00:00:00.000Z"
    });
    expect(human).not.toHaveProperty("hostId");
    expect(human).not.toHaveProperty("authority");
    expect(JSON.stringify(human)).not.toContain("host-internal");
    expect(JSON.stringify(human)).not.toContain("controlPlane");
    expect(JSON.stringify(human)).not.toContain("owner_canvas");
    expect(JSON.stringify(human)).not.toContain("workspace_canvas");
    expect(JSON.stringify(human)).not.toContain("responsibilityRevision");
  });
});
