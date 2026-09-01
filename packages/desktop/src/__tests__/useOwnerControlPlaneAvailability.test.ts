import { describe, expect, it } from "vitest";
import type { CollaborationStatus } from "../shared/collaboration";
import type { OperatorControlStatus, OperatorProfileView } from "../shared/operatorControl";
import {
  deriveCanvasAgentAuthority,
  deriveCanvasFleetCatalogAuthority,
  deriveFleetCatalogBlockedCode
} from "../renderer/hooks/useOwnerControlPlaneAvailability";

function profile(overrides: Partial<OperatorProfileView> = {}): OperatorProfileView {
  return {
    profileId: "profile-1",
    displayName: "Owner",
    serverBaseUrl: "https://example.test",
    allowInsecureTransport: false,
    hostedByThisDesktop: false,
    operatorId: "operator-1",
    humanPrincipalId: "human-owner-1",
    hasOperatorCredential: true,
    operatorCredentialPersistence: "persisted",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function status(overrides: Partial<OperatorControlStatus> = {}): OperatorControlStatus {
  return {
    activeProfileId: "profile-1",
    profiles: [profile()],
    credentialStorage: "available",
    nonPersistenceWarning: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("deriveFleetCatalogBlockedCode", () => {
  const derive = (value: OperatorControlStatus | null) =>
    deriveFleetCatalogBlockedCode(value, { bridgeAvailable: true });

  it("returns null when the active profile has an operator credential", () => {
    expect(derive(status())).toBeNull();
  });

  it("returns operator_credential_missing when the active profile lacks a credential", () => {
    expect(
      derive(
        status({
          profiles: [
            profile({ hasOperatorCredential: false, operatorCredentialPersistence: "missing" })
          ]
        })
      )
    ).toBe("operator_credential_missing");
  });

  it("returns operator_profile_not_active when no profile is active", () => {
    expect(derive(status({ activeProfileId: null }))).toBe("operator_profile_not_active");
  });

  it("blocks polling while the active local-owned server is not ready", () => {
    expect(
      derive(
        status({
          profiles: [profile({ hostedByThisDesktop: true })],
          lastErrorCode: "operator_local_server_not_ready"
        })
      )
    ).toBe("operator_local_server_not_ready");
  });

  it("does not apply a stale local-server error to a remote active profile", () => {
    expect(
      derive(
        status({
          profiles: [profile({ hostedByThisDesktop: false })],
          lastErrorCode: "operator_local_server_not_ready"
        })
      )
    ).toBeNull();
  });

  it("returns operator_bridge_unavailable when the bridge is unavailable", () => {
    expect(deriveFleetCatalogBlockedCode(status(), { bridgeAvailable: false })).toBe(
      "operator_bridge_unavailable"
    );
  });
});

describe("deriveCanvasFleetCatalogAuthority", () => {
  it("keeps the active Human fleet for an ordinary Canvas", () => {
    expect(deriveCanvasFleetCatalogAuthority({ status: status(), bridgeAvailable: true })).toEqual({
      fleetCatalogEnabled: true,
      operatorProfileId: "profile-1",
      fleetCatalogBlockedCode: null
    });
  });

  it("selects the Operator profile on the Workspace authority Server, not the global active Server", () => {
    expect(
      deriveCanvasFleetCatalogAuthority({
        status: status({
          activeProfileId: "profile-server-a",
          profiles: [
            profile({
              profileId: "profile-server-a",
              serverBaseUrl: "https://server-a.example.test"
            }),
            profile({
              profileId: "profile-server-b",
              serverBaseUrl: "https://server-b.example.test"
            })
          ]
        }),
        workspaceServerBaseUrl: "https://server-b.example.test",
        preferredProfileId: "profile-server-b",
        bridgeAvailable: true
      })
    ).toEqual({
      fleetCatalogEnabled: true,
      operatorProfileId: "profile-server-b",
      fleetCatalogBlockedCode: null
    });
  });

  it("falls back to the Workspace collaboration catalog when no same-origin profile exists", () => {
    expect(
      deriveCanvasFleetCatalogAuthority({
        status: status({
          activeProfileId: "profile-server-a",
          profiles: [
            profile({
              profileId: "profile-server-a",
              serverBaseUrl: "https://server-a.example.test"
            })
          ]
        }),
        workspaceServerBaseUrl: "https://server-b.example.test",
        preferredProfileId: "profile-server-b",
        bridgeAvailable: true
      })
    ).toEqual({
      fleetCatalogEnabled: false,
      operatorProfileId: null,
      fleetCatalogBlockedCode: null
    });
  });
});

describe("deriveCanvasAgentAuthority", () => {
  it("does not borrow an active Workspace Human when an ordinary Canvas owner is ambiguous", () => {
    expect(
      deriveCanvasAgentAuthority({
        canvasLocator: { kind: "local", projectId: "project-a", canvasId: "default" },
        collaborationMembers: [
          {
            membershipId: "membership-b",
            humanPrincipalId: "human-b",
            displayName: "Human B",
            role: "owner",
            revision: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            revokedAt: null
          }
        ],
        collaborationStatus: {
          activeProfileId: "workspace-profile-b",
          profiles: [
            {
              profileId: "workspace-profile-b",
              displayName: "Workspace B",
              serverBaseUrl: "https://server.example.test",
              projectId: "project-b",
              allowInsecureTransport: false,
              humanPrincipalId: "human-b",
              hasDeviceCredential: true,
              deviceCredentialPersistence: "persisted",
              connectionState: "ready",
              updatedAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        } as CollaborationStatus,
        ownerControlPlane: {
          fleetCatalogEnabled: true,
          operatorProfileId: "operator-profile",
          humanPrincipalId: null,
          fleetCatalogBlockedCode: null,
          status: status(),
          refresh: async () => undefined
        }
      })
    ).toMatchObject({ humanPrincipalId: null, operatorProfileId: "operator-profile" });
  });
});
