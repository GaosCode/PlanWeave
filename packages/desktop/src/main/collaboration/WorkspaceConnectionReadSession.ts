import { assertSetupViewRedacted } from "@planweave-ai/collaboration-protocol/setup";
import { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationWorkspaceClient } from "./CollaborationWorkspaceClient.js";
import { buildLiveCollaborationProfile } from "./liveServerBinding.js";
import { toPublicProfile } from "./workspaceConnectionViews.js";
import type { StoredWorkspaceConnectionProfile } from "./workspaceConnectionProfileStore.js";

/** A read owns its admitted Workspace and credential even after the active connection changes. */
export class WorkspaceConnectionReadSession {
  constructor(
    private readonly profile: StoredWorkspaceConnectionProfile,
    private readonly deviceToken: string | undefined,
    private readonly request?: typeof fetch
  ) {}

  async withWorkspaceClient<T>(
    run: (client: CollaborationWorkspaceClient) => Promise<T>
  ): Promise<T> {
    const client = new CollaborationWorkspaceClient({
      profile: toPublicProfile(this.profile),
      credential: { getDeviceToken: async () => this.deviceToken },
      request: this.request
    });
    try {
      const result = await run(client);
      assertSetupViewRedacted(result);
      return result;
    } finally {
      client.dispose();
    }
  }

  async withProjectClient<T>(
    projectId: string,
    run: (client: CollaborationClient) => Promise<T>
  ): Promise<T> {
    const client = new CollaborationClient({
      profile: buildLiveCollaborationProfile({ ...this.profile, projectId }),
      credential: { getDeviceToken: async () => this.deviceToken },
      request: this.request
    });
    try {
      return await run(client);
    } finally {
      client.dispose();
    }
  }
}
