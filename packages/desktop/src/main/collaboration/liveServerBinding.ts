import {
  collaborationConnectionProfileSchema,
  type CollaborationConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";
import { CollaborationRegistryClient } from "./CollaborationRegistryClient.js";
import { CollaborationHttpTransport } from "./collaborationHttpTransport.js";
import { collaborationEndpointForServerOrigin } from "./collaborationProfileEndpoint.js";

export type LiveRegistryProject = {
  projectId: string;
  workspaceId: string;
};

/** Prefer the current project when it still exists on this Server; otherwise the first project in the Workspace. */
export function pickLiveProjectId(input: {
  workspaceId: string;
  registryProjects: readonly LiveRegistryProject[];
  preferredProjectId: string | null;
}): string | null {
  const inWorkspace = input.registryProjects.filter(
    (project) => project.workspaceId === input.workspaceId
  );
  const pool = inWorkspace.length > 0 ? inWorkspace : input.registryProjects;
  if (
    input.preferredProjectId &&
    pool.some((project) => project.projectId === input.preferredProjectId)
  ) {
    return input.preferredProjectId;
  }
  return pool[0]?.projectId ?? null;
}

export function buildLiveCollaborationProfile(input: {
  profileId: string;
  displayName: string;
  serverBaseUrl: string;
  allowInsecureTransport: boolean;
  projectId: string;
}): CollaborationConnectionProfile {
  return collaborationConnectionProfileSchema.parse({
    profileId: input.profileId,
    displayName: input.displayName,
    serverBaseUrl: input.serverBaseUrl,
    projectId: input.projectId,
    allowInsecureTransport: input.allowInsecureTransport,
    endpoint: collaborationEndpointForServerOrigin(
      input.serverBaseUrl,
      input.allowInsecureTransport
    )
  });
}

export async function listLiveRegistryProjects(input: {
  serverBaseUrl: string;
  getDeviceToken: () => Promise<string | undefined>;
  request?: typeof fetch;
}): Promise<LiveRegistryProject[]> {
  const transport = new CollaborationHttpTransport({
    serverBaseUrl: input.serverBaseUrl,
    credential: { getDeviceToken: input.getDeviceToken },
    request: input.request
  });
  try {
    const registry = new CollaborationRegistryClient((method, path, schema, options) =>
      transport.json(method, path, schema, options)
    );
    const page = await registry.listProjects({ cursor: 0, limit: 50 });
    return page.items.map((item) => ({
      projectId: item.registry.projectId,
      workspaceId: item.registry.workspaceId
    }));
  } finally {
    transport.dispose();
  }
}
