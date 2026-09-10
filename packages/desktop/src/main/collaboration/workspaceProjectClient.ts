import { CollaborationClient } from "./CollaborationClient.js";
import type { StoredWorkspaceConnectionProfile } from "./workspaceConnectionProfileStore.js";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import { buildLiveCollaborationProfile } from "./liveServerBinding.js";

/** A bounded management request uses the Workspace credential without changing the canvas session. */
export async function withWorkspaceProjectClient<T>(input: {
  profile: StoredWorkspaceConnectionProfile;
  projectId: string;
  vault: CollaborationCredentialVault;
  request?: typeof fetch;
  run: (client: CollaborationClient) => Promise<T>;
}): Promise<T> {
  const client = new CollaborationClient({
    profile: buildLiveCollaborationProfile({ ...input.profile, projectId: input.projectId }),
    credential: { getDeviceToken: () => input.vault.getDeviceToken(input.profile.profileId) },
    request: input.request
  });
  try {
    return await input.run(client);
  } finally {
    client.dispose();
  }
}
