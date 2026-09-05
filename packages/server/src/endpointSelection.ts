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
      reviewerRevision: z.number().int().nonnegative(),
      executionTargetRevision: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("endpoint-authority/v2"),
      kind: z.literal("workspace_canvas"),
      workspaceId: workspaceIdSchema,
      responsibilityRevision: z.number().int().nonnegative(),
      reviewerRevision: z.number().int().nonnegative(),
      executionTargetRevision: z.number().int().nonnegative()
    })
    .strict()
]);

export const legacyRuntimeAuthoritySnapshotSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal("endpoint-authority/v2"),
      kind: z.literal("owner_canvas"),
      responsibilityRevision: z.number().int().nonnegative(),
      reviewerRevision: z.number().int().nonnegative(),
      executionTargetRevision: z.number().int().nonnegative().optional()
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("endpoint-authority/v2"),
      kind: z.literal("workspace_canvas"),
      workspaceId: workspaceIdSchema,
      responsibilityRevision: z.number().int().nonnegative(),
      reviewerRevision: z.number().int().nonnegative(),
      executionTargetRevision: z.number().int().nonnegative().optional()
    })
    .strict()
]);

/** Explicit recovery-only reader for historical authority snapshots. */
export const legacyEndpointAuthoritySnapshotSchema = z.union([
  legacyRuntimeAuthoritySnapshotSchema,
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
export const legacyEndpointSelectionSnapshotSchema = endpointSelectionFields
  .extend({
    authority: legacyEndpointAuthoritySnapshotSchema
  })
  .strict();

export const readableEndpointSelectionSnapshotSchema = endpointSelectionFields
  .extend({ authority: legacyRuntimeAuthoritySnapshotSchema })
  .strict();

export type ReadableEndpointSelectionSnapshot = z.infer<
  typeof readableEndpointSelectionSnapshotSchema
>;

export const writeEndpointSelectionSnapshotSchema = endpointSelectionFields
  .extend({
    authority: runtimeAuthoritySnapshotSchema
  })
  .strict();
export const endpointSelectionSnapshotSchema = writeEndpointSelectionSnapshotSchema;

export type EndpointAuthorityV1Snapshot = z.infer<typeof endpointAuthorityV1SnapshotSchema>;
export type RuntimeAuthoritySnapshot = z.infer<typeof runtimeAuthoritySnapshotSchema>;
export type EndpointSelectionSnapshot = z.infer<typeof writeEndpointSelectionSnapshotSchema>;
export type PersistedEndpointSelectionSnapshot = z.infer<
  typeof legacyEndpointSelectionSnapshotSchema
>;

export function mapEndpointAuthorityToRuntimeSnapshot(
  authority: z.infer<typeof legacyEndpointAuthoritySnapshotSchema>,
  workspaceId: string
): RuntimeAuthoritySnapshot {
  if (authority.schemaVersion === "endpoint-authority/v2") {
    return runtimeAuthoritySnapshotSchema.parse(authority);
  }
  workspaceIdSchema.parse(workspaceId);
  throw new Error("endpoint_authority_execution_target_revision_missing");
}

export function readEndpointSelectionSnapshot(
  value: unknown,
  workspaceId: string
): ReadableEndpointSelectionSnapshot {
  const parsed = legacyEndpointSelectionSnapshotSchema.parse(value);
  workspaceIdSchema.parse(workspaceId);
  if (parsed.authority.schemaVersion !== "endpoint-authority/v2") {
    throw new Error("endpoint_authority_execution_target_revision_missing");
  }
  if (
    parsed.authority.kind === "workspace_canvas" &&
    parsed.authority.workspaceId !== workspaceId
  ) {
    throw new Error("endpoint_authority_workspace_mismatch");
  }
  return readableEndpointSelectionSnapshotSchema.parse(parsed);
}

export function persistEndpointSelectionSnapshot(
  value: unknown,
  _workspaceId: string
): EndpointSelectionSnapshot {
  return writeEndpointSelectionSnapshotSchema.parse(value);
}

export function runtimeAuthoritySnapshotForTarget(
  target: { kind: "owner_canvas" } | { kind: "workspace_canvas"; workspaceId: string },
  revisions: {
    responsibilityRevision: number;
    reviewerRevision: number;
    executionTargetRevision: number;
  }
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
  authority: Pick<RuntimeAuthoritySnapshot, "kind"> | undefined
): "collaboration" | "owner" {
  return authority?.kind === "owner_canvas" ? "owner" : "collaboration";
}

export function isOwnerCanvasRuntime(
  authority: Pick<RuntimeAuthoritySnapshot, "kind"> | undefined
): boolean {
  return authority?.kind === "owner_canvas";
}

/** Restart-safe internal route snapshot. hostId never crosses the human projection boundary. */
export function toHumanEndpointSnapshot(selection: ReadableEndpointSelectionSnapshot) {
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
