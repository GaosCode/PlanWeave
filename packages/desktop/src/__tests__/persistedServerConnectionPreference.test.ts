import { describe, expect, it } from "vitest";
import { inferPersistedRemoteProfileId } from "../main/collaboration/persistedServerConnectionPreference.js";

describe("inferPersistedRemoteProfileId", () => {
  const local = {
    profileId: "planweave-local-d5e342216f40e0632c512d0d",
    updatedAt: "2026-08-19T04:18:26.897Z"
  };
  const remote = {
    profileId: "profile-a30ac80f13f64bf7133c64cc",
    updatedAt: "2026-08-19T04:18:26.137Z"
  };

  it("uses lastConnection even when a local profile stole activeProfileId", () => {
    expect(
      inferPersistedRemoteProfileId({
        lastConnection: { kind: "remote", profileId: remote.profileId },
        activeProfileId: local.profileId,
        profiles: [local, remote]
      })
    ).toBe(remote.profileId);
  });

  it("keeps this computer when lastConnection is local", () => {
    expect(
      inferPersistedRemoteProfileId({
        lastConnection: { kind: "local" },
        activeProfileId: local.profileId,
        profiles: [local, remote]
      })
    ).toBeNull();
  });

  it("uses the active remote profile when lastConnection is missing", () => {
    expect(
      inferPersistedRemoteProfileId({
        activeProfileId: remote.profileId,
        profiles: [local, remote]
      })
    ).toBe(remote.profileId);
  });

  it("repairs a local adopt that stole activeProfileId immediately after a remote connect", () => {
    expect(
      inferPersistedRemoteProfileId({
        activeProfileId: local.profileId,
        profiles: [local, remote]
      })
    ).toBe(remote.profileId);
  });

  it("does not treat an older remote as last when this computer stayed active", () => {
    expect(
      inferPersistedRemoteProfileId({
        activeProfileId: local.profileId,
        profiles: [
          { ...local, updatedAt: "2026-08-19T05:00:00.000Z" },
          { ...remote, updatedAt: "2026-08-18T04:18:26.137Z" }
        ]
      })
    ).toBeNull();
  });
});
