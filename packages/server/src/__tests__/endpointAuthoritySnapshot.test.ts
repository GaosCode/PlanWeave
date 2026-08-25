import { describe, expect, it } from "vitest";
import {
  endpointSelectionSnapshotSchema,
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
    reviewerRevision: 3
  }
};

const v2Owner = {
  ...selectionBase,
  authority: {
    schemaVersion: "endpoint-authority/v2" as const,
    kind: "owner_canvas" as const,
    responsibilityRevision: 4,
    reviewerRevision: 5
  }
};

describe("endpoint-authority snapshot", () => {
  it("parses both endpoint-authority/v1 and v2 inside endpoint-selection/v1", () => {
    expect(endpointSelectionSnapshotSchema.parse(v1Collaboration)).toEqual(v1Collaboration);
    expect(endpointSelectionSnapshotSchema.parse(v1Owner)).toEqual(v1Owner);
    expect(endpointSelectionSnapshotSchema.parse(v2Workspace)).toEqual(v2Workspace);
    expect(endpointSelectionSnapshotSchema.parse(v2Owner)).toEqual(v2Owner);
  });

  it("maps v1 controlPlane to v2 runtime authority using the operation workspace", () => {
    expect(mapEndpointAuthorityToRuntimeSnapshot(v1Owner.authority, "workspace-a")).toEqual({
      schemaVersion: "endpoint-authority/v2",
      kind: "owner_canvas",
      responsibilityRevision: 4,
      reviewerRevision: 5
    });
    expect(mapEndpointAuthorityToRuntimeSnapshot(v1Collaboration.authority, "workspace-a")).toEqual(
      {
        schemaVersion: "endpoint-authority/v2",
        kind: "workspace_canvas",
        workspaceId: "workspace-a",
        responsibilityRevision: 2,
        reviewerRevision: 3
      }
    );
    expect(readEndpointSelectionSnapshot(v1Collaboration, "workspace-a")).toEqual(v2Workspace);
    expect(readEndpointSelectionSnapshot(v1Owner, "workspace-ignored")).toEqual(v2Owner);
  });

  it("persists v2 only and rejects a workspace_canvas snapshot without workspaceId", () => {
    expect(persistEndpointSelectionSnapshot(v1Collaboration, "workspace-a")).toEqual(v2Workspace);
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

  it("builds runtime snapshots from dispatch targets and maps them back to claim controlPlane", () => {
    expect(
      runtimeAuthoritySnapshotForTarget(
        { kind: "owner_canvas" },
        { responsibilityRevision: 1, reviewerRevision: 2 }
      )
    ).toEqual({
      schemaVersion: "endpoint-authority/v2",
      kind: "owner_canvas",
      responsibilityRevision: 1,
      reviewerRevision: 2
    });
    expect(
      runtimeAuthoritySnapshotForTarget(
        { kind: "workspace_canvas", workspaceId: "workspace-a" },
        { responsibilityRevision: 1, reviewerRevision: 2 }
      )
    ).toEqual({
      schemaVersion: "endpoint-authority/v2",
      kind: "workspace_canvas",
      workspaceId: "workspace-a",
      responsibilityRevision: 1,
      reviewerRevision: 2
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
