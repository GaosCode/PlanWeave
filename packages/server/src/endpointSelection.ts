import {
  availableRemoteAgentEndpointSchema,
  agentEndpointCapabilitiesSchema
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";

export const endpointAuthorityV1SnapshotSchema = z
  .object({
    schemaVersion: z.literal("endpoint-authority/v1"),
    controlPlane: z.enum(["collaboration", "owner"]).default("collaboration"),
    responsibilityRevision: z.number().int().nonnegative(),
    reviewerRevision: z.number().int().nonnegative()
  })
  .strict();

export const runtimeAuthoritySnapshotSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal("endpoint-authority/v2"),
      kind: z.literal("owner_canvas"),
      responsibilityRevision: z.number().int().nonnegative(),
      reviewerRevision: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("endpoint-authority/v2"),
      kind: z.literal("workspace_canvas"),
      workspaceId: workspaceIdSchema,
      responsibilityRevision: z.number().int().nonnegative(),
      reviewerRevision: z.number().int().nonnegative()
    })
    .strict()
]);

/** Disk and input reader: v1 controlPlane or v2 runtime kind. */
export const endpointAuthoritySnapshotSchema = z.union([
  runtimeAuthoritySnapshotSchema,
  endpointAuthorityV1SnapshotSchema
]);

const endpointSelectionFields = availableRemoteAgentEndpointSchema
  .pick({
    endpointId: true,
    profileId: true,
    agentId: true,
    displayName: true,
    hostDisplayName: true,
    capabilities: true
  })
  .extend({
    schemaVersion: z.literal("endpoint-selection/v1"),
    hostId: opaqueIdentifierSchema,
    capabilities: agentEndpointCapabilitiesSchema,
    resolvedAt: z.iso.datetime()
  });

/** Parses both v1 and v2 authority. New writes must persist v2 via persistEndpointSelectionSnapshot. */
export const endpointSelectionSnapshotSchema = endpointSelectionFields
  .extend({
    authority: endpointAuthoritySnapshotSchema
  })
  .strict();

export const writeEndpointSelectionSnapshotSchema = endpointSelectionFields
  .extend({
    authority: runtimeAuthoritySnapshotSchema
  })
  .strict();

export type EndpointAuthorityV1Snapshot = z.infer<typeof endpointAuthorityV1SnapshotSchema>;
export type RuntimeAuthoritySnapshot = z.infer<typeof runtimeAuthoritySnapshotSchema>;
export type EndpointSelectionSnapshot = z.infer<typeof writeEndpointSelectionSnapshotSchema>;
export type PersistedEndpointSelectionSnapshot = z.infer<typeof endpointSelectionSnapshotSchema>;

export function mapEndpointAuthorityToRuntimeSnapshot(
  authority: z.infer<typeof endpointAuthoritySnapshotSchema>,
  workspaceId: string
): RuntimeAuthoritySnapshot {
  if (authority.schemaVersion === "endpoint-authority/v2") {
    return runtimeAuthoritySnapshotSchema.parse(authority);
  }
  const revisions = {
    responsibilityRevision: authority.responsibilityRevision,
    reviewerRevision: authority.reviewerRevision
  };
  if (authority.controlPlane === "owner") {
    return runtimeAuthoritySnapshotSchema.parse({
      schemaVersion: "endpoint-authority/v2",
      kind: "owner_canvas",
      ...revisions
    });
  }
  return runtimeAuthoritySnapshotSchema.parse({
    schemaVersion: "endpoint-authority/v2",
    kind: "workspace_canvas",
    workspaceId: workspaceIdSchema.parse(workspaceId),
    ...revisions
  });
}

export function readEndpointSelectionSnapshot(
  value: unknown,
  workspaceId: string
): EndpointSelectionSnapshot {
  const parsed = endpointSelectionSnapshotSchema.parse(value);
  return writeEndpointSelectionSnapshotSchema.parse({
    ...parsed,
    authority: mapEndpointAuthorityToRuntimeSnapshot(parsed.authority, workspaceId)
  });
}

export function persistEndpointSelectionSnapshot(
  value: unknown,
  workspaceId: string
): EndpointSelectionSnapshot {
  return writeEndpointSelectionSnapshotSchema.parse(
    readEndpointSelectionSnapshot(value, workspaceId)
  );
}

export function runtimeAuthoritySnapshotForTarget(
  target: { kind: "owner_canvas" } | { kind: "workspace_canvas"; workspaceId: string },
  revisions: { responsibilityRevision: number; reviewerRevision: number }
): RuntimeAuthoritySnapshot {
  if (target.kind === "owner_canvas") {
    return runtimeAuthoritySnapshotSchema.parse({
      schemaVersion: "endpoint-authority/v2",
      kind: "owner_canvas",
      ...revisions
    });
  }
  return runtimeAuthoritySnapshotSchema.parse({
    schemaVersion: "endpoint-authority/v2",
    kind: "workspace_canvas",
    workspaceId: target.workspaceId,
    ...revisions
  });
}

export function runtimeControlPlane(
  authority: RuntimeAuthoritySnapshot | undefined
): "collaboration" | "owner" {
  return authority?.kind === "owner_canvas" ? "owner" : "collaboration";
}

export function isOwnerCanvasRuntime(authority: RuntimeAuthoritySnapshot | undefined): boolean {
  return authority?.kind === "owner_canvas";
}

/** Restart-safe internal route snapshot. hostId never crosses the human projection boundary. */
export function toHumanEndpointSnapshot(selection: EndpointSelectionSnapshot) {
  return availableRemoteAgentEndpointSchema
    .extend({ resolvedAt: z.iso.datetime() })
    .strict()
    .parse({
      schemaVersion: "agent-endpoint/v1",
      endpointId: selection.endpointId,
      profileId: selection.profileId,
      agentId: selection.agentId,
      displayName: selection.displayName,
      hostDisplayName: selection.hostDisplayName,
      capabilities: selection.capabilities,
      status: "available",
      resolvedAt: selection.resolvedAt
    });
}
