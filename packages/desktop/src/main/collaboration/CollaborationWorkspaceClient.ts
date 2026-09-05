import {
  workspaceConnectionMembersPageSchema,
  workspaceConnectionSelfViewSchema,
  workspacePickerPageSchema,
  type CollaborationClientLimits,
  type WorkspaceConnectionMembersPage,
  type WorkspaceConnectionProfile,
  type WorkspaceConnectionSelfView,
  type WorkspacePickerPage
} from "@planweave-ai/collaboration-protocol/connection";
import type {
  CollaborationClientClock,
  CollaborationCredentialPort
} from "./collaborationClientTypes.js";
import { CollaborationHttpTransport } from "./collaborationHttpTransport.js";

export type CollaborationWorkspaceClientOptions = {
  profile: WorkspaceConnectionProfile;
  credential: CollaborationCredentialPort;
  limits?: Partial<CollaborationClientLimits>;
  request?: typeof fetch;
  clock?: CollaborationClientClock;
};

/**
 * Workspace-scoped authenticated Server reads. Project operations intentionally
 * remain on CollaborationClient and require an explicit project profile.
 */
export class CollaborationWorkspaceClient {
  private readonly transport: CollaborationHttpTransport;

  constructor(options: CollaborationWorkspaceClientOptions) {
    this.transport = new CollaborationHttpTransport({
      serverBaseUrl: options.profile.serverBaseUrl,
      credential: options.credential,
      limits: options.limits,
      request: options.request,
      clock: options.clock
    });
  }

  async listWorkspaces(input: { cursor: number; limit: number }): Promise<WorkspacePickerPage> {
    const query = new URLSearchParams({ cursor: String(input.cursor), limit: String(input.limit) });
    return this.transport.json(
      "GET",
      `/api/v1/workspace-connection?${query}`,
      workspacePickerPageSchema
    );
  }

  async getSelf(): Promise<WorkspaceConnectionSelfView> {
    return this.transport.json(
      "GET",
      "/api/v1/workspace-connection/self",
      workspaceConnectionSelfViewSchema
    );
  }

  async updateSelf(displayName: string): Promise<WorkspaceConnectionSelfView> {
    return this.transport.json(
      "PATCH",
      "/api/v1/workspace-connection/self",
      workspaceConnectionSelfViewSchema,
      {
        body: {
          schemaVersion: "workspace-setup/v1",
          displayName
        }
      }
    );
  }

  async listMembers(input: {
    cursor: number;
    limit: number;
  }): Promise<WorkspaceConnectionMembersPage> {
    const query = new URLSearchParams({ cursor: String(input.cursor), limit: String(input.limit) });
    return this.transport.json(
      "GET",
      `/api/v1/workspace-connection/members?${query}`,
      workspaceConnectionMembersPageSchema
    );
  }

  dispose(): void {
    this.transport.dispose();
  }
}
