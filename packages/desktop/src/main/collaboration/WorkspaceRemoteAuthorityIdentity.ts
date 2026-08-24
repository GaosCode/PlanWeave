import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator.js";

const identifierSchema = z.string().trim().min(1).max(256);
const canonicalServerOriginSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).origin === value, "workspace_remote_origin_not_canonical");

export const workspaceRemoteAuthorityKeySchema = z
  .object({
    connectionProfileId: identifierSchema,
    serverOrigin: canonicalServerOriginSchema,
    workspaceId: workspaceIdSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema
  })
  .strict();
export type WorkspaceRemoteAuthorityKey = z.infer<typeof workspaceRemoteAuthorityKeySchema>;

export function workspaceRemoteAuthorityId(
  input: Pick<WorkspaceRemoteAuthorityKey, "connectionProfileId" | "serverOrigin" | "projectId">
): string {
  return `${input.connectionProfileId}\u0000${input.serverOrigin}\u0000${input.projectId}`;
}

export function workspaceRemoteAuthorityKeyFromProfile(
  locator: WorkspaceCanvasLocator,
  profile: { profileId: string; serverBaseUrl: string; projectId: string; workspaceId?: string }
): WorkspaceRemoteAuthorityKey {
  if (
    profile.profileId !== locator.connectionProfileId ||
    profile.projectId !== locator.projectId
  ) {
    throw new Error("workspace_remote_authority_profile_identity_mismatch");
  }
  if (profile.workspaceId !== undefined && profile.workspaceId !== locator.workspaceId) {
    throw new Error("workspace_remote_authority_workspace_mismatch");
  }
  return workspaceRemoteAuthorityKeySchema.parse({
    connectionProfileId: profile.profileId,
    serverOrigin: new URL(profile.serverBaseUrl).origin,
    workspaceId: locator.workspaceId,
    projectId: locator.projectId,
    canvasId: locator.canvasId
  });
}
