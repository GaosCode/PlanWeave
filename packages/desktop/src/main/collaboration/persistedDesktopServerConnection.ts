/**
 * Chooses whether Desktop startup reconnects a remembered remote Server
 * or restores this computer's local Server. Last remote wins over local auto-start.
 */
export async function restorePersistedDesktopServerConnection(input: {
  peekPersistedRemoteProfileId(): Promise<string | null>;
  restoreLocal(): Promise<void>;
  restoreRemote(profileId: string): Promise<void>;
}): Promise<"local" | "remote"> {
  const remoteProfileId = await input.peekPersistedRemoteProfileId();
  if (remoteProfileId) {
    try {
      await input.restoreRemote(remoteProfileId);
    } catch {
      // Keep last remote even when the Server is temporarily unreachable.
    }
    return "remote";
  }
  await input.restoreLocal();
  return "local";
}
