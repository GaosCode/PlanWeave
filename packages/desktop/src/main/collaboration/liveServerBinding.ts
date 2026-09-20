import {
  collaborationConnectionProfileSchema,
  type CollaborationConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";
import { CollaborationRegistryClient } from "./CollaborationRegistryClient.js";
import { CollaborationHttpTransport } from "./collaborationHttpTransport.js";
import { collaborationEndpointForServerOrigin } from "./collaborationProfileEndpoint.js";
import { CollaborationClientError } from "./collaborationErrors.js";

const REGISTRY_PAGE_LIMIT = 100;

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
  if (
    input.preferredProjectId &&
    inWorkspace.some((project) => project.projectId === input.preferredProjectId)
  ) {
    return input.preferredProjectId;
  }
  return inWorkspace[0]?.projectId ?? null;
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
    const projects: LiveRegistryProject[] = [];
    let cursor = 0;
    for (let pageCount = 0; pageCount < REGISTRY_PAGE_LIMIT; pageCount += 1) {
      const page = await registry.listProjects({ cursor, limit: 50 });
      projects.push(
        ...page.items.map((item) => ({
          projectId: item.registry.projectId,
          workspaceId: item.registry.workspaceId
        }))
      );
      if (page.nextCursor === null) return projects;
      if (page.nextCursor <= cursor) {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "live_registry_pagination_invalid",
          message: "Project registry pagination did not advance.",
          retryable: false
        });
      }
      cursor = page.nextCursor;
    }
    throw new CollaborationClientError({
      kind: "protocol",
      code: "live_registry_page_limit_exceeded",
      message: "Project registry exceeded the supported limit of 100 pages (50 projects per page).",
      retryable: false
    });
  } finally {
    transport.dispose();
  }
}
