import { describe, expect, it, vi } from "vitest";
import { restorePersistedDesktopServerConnection } from "../main/collaboration/persistedDesktopServerConnection.js";

describe("restorePersistedDesktopServerConnection", () => {
  it("reconnects the last remote Server and does not start this computer", async () => {
    const restoreLocal = vi.fn(async () => undefined);
    const restoreRemote = vi.fn(async () => undefined);

    await expect(
      restorePersistedDesktopServerConnection({
        peekPersistedRemoteProfileId: async () => "profile-workspace-001",
        restoreLocal,
        restoreRemote
      })
    ).resolves.toBe("remote");

    expect(restoreRemote).toHaveBeenCalledOnce();
    expect(restoreRemote).toHaveBeenCalledWith("profile-workspace-001");
    expect(restoreLocal).not.toHaveBeenCalled();
  });

  it("restores this computer when the last connection was local", async () => {
    const restoreLocal = vi.fn(async () => undefined);
    const restoreRemote = vi.fn(async () => undefined);

    await expect(
      restorePersistedDesktopServerConnection({
        peekPersistedRemoteProfileId: async () => null,
        restoreLocal,
        restoreRemote
      })
    ).resolves.toBe("local");

    expect(restoreLocal).toHaveBeenCalledOnce();
    expect(restoreRemote).not.toHaveBeenCalled();
  });

  it("stays on the last remote Server when reconnect fails", async () => {
    const restoreLocal = vi.fn(async () => undefined);
    const restoreRemote = vi.fn(async () => {
      throw new Error("SERVER_UNREACHABLE");
    });

    await expect(
      restorePersistedDesktopServerConnection({
        peekPersistedRemoteProfileId: async () => "profile-workspace-001",
        restoreLocal,
        restoreRemote
      })
    ).resolves.toBe("remote");

    expect(restoreRemote).toHaveBeenCalledOnce();
    expect(restoreLocal).not.toHaveBeenCalled();
  });
});
