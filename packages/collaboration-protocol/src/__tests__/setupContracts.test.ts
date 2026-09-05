import { describe, expect, it } from "vitest";
import {
  activeWorkspaceConnectionViewSchema,
  collaborationServerOriginSchema,
  workspaceConnectionProfileSchema,
  workspacePickerPageSchema
} from "../connection.js";
import {
  assertSetupRedeemPurposeMatch,
  assertSetupViewRedacted,
  deriveSetupCodeLifecycleState,
  evaluateSetupCodeUsability,
  hostBootstrapEnrollmentSecretSchema,
  hostBootstrapHandoffViewSchema,
  setupCodeGrantSchema,
  setupCodeIssueRequestSchema,
  setupCodeIssueResponseSchema,
  setupCodeRedeemDeviceRequestSchema,
  setupCodeRedeemHostRequestSchema,
  setupCodeRedeemOperatorRequestSchema,
  setupCodeRedeemRequestSchema,
  setupCodeRedeemResponseSchema
} from "../setup.js";
import {
  exampleActiveWorkspaceConnectionConnected,
  exampleActiveWorkspaceConnectionLocalOnly,
  exampleHostBootstrapEnrollmentSecret,
  exampleHostBootstrapHandoffView,
  exampleSetupCode,
  exampleSetupCodeGrant,
  exampleSetupCodeGrantView,
  exampleSetupCodeIssueResponse,
  exampleSetupCodeNegativeFixtures,
  exampleSetupCodeRedeemDeviceResponse,
  exampleSetupCodeRedeemHostResponse,
  exampleSetupCodeRedeemOperatorResponse,
  exampleSetupCodeRevocation,
  exampleWorkspaceConnectionMembersPage,
  exampleWorkspaceConnectionProfile,
  exampleWorkspaceConnectionSelf,
  exampleWorkspacePickerPage
} from "../fixtures/collaboration.js";
import { setupCodeTokenSchema } from "../primitives.js";
import { setupPurposeCredentialDomain } from "../identity.js";

const now = new Date("2030-01-01T00:30:00.000Z");

describe("OSS-005 setup-code and single-connection contracts", () => {
  it("issues a one-time setup code without projectRoot, long-lived secrets, or commands", () => {
    expect(exampleSetupCodeIssueResponse.displayOnce).toBe(true);
    expect(exampleSetupCodeIssueResponse.setupCode).toMatch(/^pw_setup_/);
    expect(exampleSetupCodeGrantView.state).toBe("displayed");
    expect(
      setupCodeIssueRequestSchema.parse({
        schemaVersion: "workspace-setup/v1",
        workspaceId: "workspace-demo-001",
        purpose: "device_session",
        ttlMs: 3_600_000
      }).purpose
    ).toBe("device_session");
    expect(() =>
      setupCodeIssueRequestSchema.parse(exampleSetupCodeNegativeFixtures.malformedIssueRequest)
    ).toThrow();
    expect(() =>
      setupCodeIssueRequestSchema.parse({
        schemaVersion: "workspace-setup/v1",
        workspaceId: "workspace-demo-001",
        purpose: "device_session",
        serverBaseUrl: "https://evil.example/path"
      })
    ).toThrow();
  });

  it("redeems once per purpose and rejects replay, expiry, revoke, and wrong purpose", () => {
    expect(
      evaluateSetupCodeUsability({
        grant: exampleSetupCodeGrant,
        workspaceId: "workspace-demo-001",
        purpose: "device_session",
        now
      })
    ).toEqual({ usable: true, state: "displayed" });

    expect(
      evaluateSetupCodeUsability({
        grant: exampleSetupCodeNegativeFixtures.expiredGrant,
        workspaceId: "workspace-demo-001",
        purpose: "device_session",
        now
      })
    ).toEqual({ usable: false, state: "expired" });

    expect(
      evaluateSetupCodeUsability({
        grant: exampleSetupCodeNegativeFixtures.revokedGrant,
        workspaceId: "workspace-demo-001",
        purpose: "device_session",
        now
      })
    ).toEqual({ usable: false, state: "revoked" });

    expect(
      evaluateSetupCodeUsability({
        grant: exampleSetupCodeNegativeFixtures.redeemedGrant,
        workspaceId: "workspace-demo-001",
        purpose: "device_session",
        now
      })
    ).toEqual({ usable: false, state: "redeemed" });

    expect(
      evaluateSetupCodeUsability({
        grant: exampleSetupCodeNegativeFixtures.crossWorkspaceGrant,
        workspaceId: "workspace-demo-001",
        purpose: "device_session",
        now
      })
    ).toEqual({ usable: false, state: "workspace_mismatch" });

    expect(
      evaluateSetupCodeUsability({
        grant: exampleSetupCodeNegativeFixtures.hostPurposeGrant,
        workspaceId: "workspace-demo-001",
        purpose: "device_session",
        now
      })
    ).toEqual({ usable: false, state: "purpose_mismatch" });

    expect(() =>
      assertSetupRedeemPurposeMatch(exampleSetupCodeNegativeFixtures.hostPurposeGrant, {
        purpose: "device_session"
      })
    ).toThrow("setup_code_purpose_mismatch");

    expect(deriveSetupCodeLifecycleState({ grant: exampleSetupCodeGrant, now })).toBe("displayed");
    expect(
      deriveSetupCodeLifecycleState({
        grant: exampleSetupCodeNegativeFixtures.redeemedGrant,
        now
      })
    ).toBe("redeemed");
  });

  it("keeps human, operator, and Host redeem outcomes as separate credential domains", () => {
    expect(setupPurposeCredentialDomain.device_session).toBe("human_device");
    expect(setupPurposeCredentialDomain.operator_session).toBe("operator");
    expect(setupPurposeCredentialDomain.host_enrollment).toBe("agent_host");

    expect(setupCodeRedeemResponseSchema.parse(exampleSetupCodeRedeemDeviceResponse).purpose).toBe(
      "device_session"
    );
    expect(
      setupCodeRedeemResponseSchema.parse(exampleSetupCodeRedeemOperatorResponse).purpose
    ).toBe("operator_session");
    expect(setupCodeRedeemResponseSchema.parse(exampleSetupCodeRedeemHostResponse).purpose).toBe(
      "host_enrollment"
    );

    expect(
      setupCodeRedeemDeviceRequestSchema.parse({
        schemaVersion: "workspace-setup/v1",
        setupCode: exampleSetupCode,
        purpose: "device_session",
        displayName: "Owner",
        deviceLabel: "Laptop"
      }).purpose
    ).toBe("device_session");

    expect(
      setupCodeRedeemDeviceRequestSchema.parse({
        schemaVersion: "workspace-setup/v1",
        setupCode: exampleSetupCode,
        purpose: "device_session",
        displayName: "Owner",
        existingDeviceToken: exampleSetupCodeRedeemDeviceResponse.deviceToken
      }).existingDeviceToken
    ).toBe(exampleSetupCodeRedeemDeviceResponse.deviceToken);

    expect(
      setupCodeRedeemDeviceRequestSchema.parse({
        schemaVersion: "workspace-setup/v1",
        setupCode: exampleSetupCode,
        purpose: "device_session",
        displayName: "Owner",
        existingIdentityToken: exampleSetupCodeRedeemDeviceResponse.identityToken
      }).existingIdentityToken
    ).toBe(exampleSetupCodeRedeemDeviceResponse.identityToken);

    expect(() =>
      setupCodeRedeemDeviceRequestSchema.parse({
        schemaVersion: "workspace-setup/v1",
        setupCode: exampleSetupCode,
        purpose: "device_session",
        displayName: "Owner",
        existingIdentityToken: exampleSetupCodeRedeemDeviceResponse.identityToken,
        existingDeviceToken: exampleSetupCodeRedeemDeviceResponse.deviceToken
      })
    ).toThrow();

    expect(() =>
      setupCodeRedeemDeviceRequestSchema.parse(
        exampleSetupCodeNegativeFixtures.mixedCredentialRedeem
      )
    ).toThrow();

    expect(() =>
      setupCodeRedeemRequestSchema.parse(exampleSetupCodeNegativeFixtures.wrongCredentialPrefix)
    ).toThrow();

    expect(() =>
      setupCodeRedeemOperatorRequestSchema.parse({
        schemaVersion: "workspace-setup/v1",
        setupCode: exampleSetupCode,
        purpose: "operator_session",
        displayName: "Admin",
        deviceToken: exampleSetupCodeRedeemDeviceResponse.deviceToken
      })
    ).toThrow();

    expect(
      setupCodeRedeemHostRequestSchema.parse({
        schemaVersion: "workspace-setup/v1",
        setupCode: exampleSetupCode,
        purpose: "host_enrollment",
        displayName: "Build Host",
        capabilities: ["acp.codex"],
        capacity: 2,
        enrollmentAttemptId: "enroll-setup-001",
        hostCredentialToken: `pw_host_${"A".repeat(43)}`
      }).purpose
    ).toBe("host_enrollment");

    expect(() =>
      setupCodeRedeemHostRequestSchema.parse({
        schemaVersion: "workspace-setup/v1",
        setupCode: exampleSetupCode,
        purpose: "host_enrollment",
        displayName: "Build Host",
        capabilities: ["acp.codex"],
        capacity: 2,
        enrollmentAttemptId: "enroll-setup-001",
        hostCredentialToken: `pw_hdev_${"A".repeat(43)}`
      })
    ).toThrow();

    expect(() => setupCodeRedeemDeviceResponseSchemaWithMixedSecrets()).toThrow();
  });

  it("bounds Server origins to HTTPS with explicit loopback and private-LAN exceptions", () => {
    expect(collaborationServerOriginSchema.parse("https://collab.example.com/")).toBe(
      "https://collab.example.com/"
    );
    expect(() => collaborationServerOriginSchema.parse("https://collab.example.com/api")).toThrow();
    expect(() => collaborationServerOriginSchema.parse("ftp://collab.example.com/")).toThrow();
    expect(() =>
      collaborationServerOriginSchema.parse("https://user:pass@collab.example.com/")
    ).toThrow();

    expect(
      workspaceConnectionProfileSchema.parse({
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-loopback",
        displayName: "Loopback",
        serverBaseUrl: "http://127.0.0.1:8787/",
        workspaceId: "workspace-demo-001",
        allowInsecureTransport: true
      }).allowInsecureTransport
    ).toBe(true);

    expect(
      workspaceConnectionProfileSchema.parse({
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-lan",
        displayName: "LAN",
        serverBaseUrl: "http://10.0.0.15:8787/",
        workspaceId: "workspace-demo-001",
        allowInsecureTransport: true
      }).serverBaseUrl
    ).toBe("http://10.0.0.15:8787/");

    expect(() =>
      workspaceConnectionProfileSchema.parse({
        ...exampleWorkspaceConnectionProfile,
        serverBaseUrl: "http://example.com/",
        allowInsecureTransport: true
      })
    ).toThrow();

    expect(() =>
      hostBootstrapHandoffViewSchema.parse(exampleSetupCodeNegativeFixtures.arbitraryUrlHandoff)
    ).toThrow();
  });

  it("models a single Workspace connection and a redacted picker page", () => {
    expect(exampleActiveWorkspaceConnectionLocalOnly.status).toBe("local_only");
    expect(exampleActiveWorkspaceConnectionConnected.workspaceId).toBe(
      exampleWorkspaceConnectionProfile.workspaceId
    );
    expect(exampleWorkspacePickerPage.items).toHaveLength(2);

    expect(() =>
      activeWorkspaceConnectionViewSchema.parse({
        schemaVersion: "workspace-setup/v1",
        status: "local_only",
        profile: exampleWorkspaceConnectionProfile,
        workspaceId: "workspace-demo-001",
        workspaceDisplayName: "PlanWeave Demo",
        connectedAt: null,
        error: null
      })
    ).toThrow();

    expect(() =>
      activeWorkspaceConnectionViewSchema.parse({
        schemaVersion: "workspace-setup/v1",
        status: "connected",
        profile: exampleWorkspaceConnectionProfile,
        workspaceId: "workspace-other-001",
        workspaceDisplayName: "Other",
        connectedAt: "2030-01-01T00:05:00.000Z",
        error: null
      })
    ).toThrow();

    expect(() =>
      workspacePickerPageSchema.parse({
        schemaVersion: "workspace-setup/v1",
        items: [
          {
            schemaVersion: "workspace-setup/v1",
            workspaceId: "workspace-demo-001",
            displayName: "PlanWeave Demo",
            role: "owner",
            archivedAt: null,
            membershipActive: true,
            setupCode: exampleSetupCode
          }
        ],
        nextCursor: null
      })
    ).toThrow();
  });

  it("keeps Host bootstrap views redacted and secret envelopes purpose-bound", () => {
    expect(exampleHostBootstrapHandoffView.state).toBe("pending");
    assertSetupViewRedacted(exampleHostBootstrapHandoffView);
    assertSetupViewRedacted(exampleSetupCodeGrantView);
    assertSetupViewRedacted(exampleWorkspacePickerPage);
    assertSetupViewRedacted(exampleActiveWorkspaceConnectionConnected);
    assertSetupViewRedacted(exampleWorkspaceConnectionSelf);
    assertSetupViewRedacted(exampleWorkspaceConnectionMembersPage);

    for (const value of [
      { setupCode: exampleSetupCode },
      { deviceToken: exampleSetupCodeRedeemDeviceResponse.deviceToken },
      { identityToken: exampleSetupCodeRedeemDeviceResponse.identityToken },
      { operatorToken: exampleSetupCodeRedeemOperatorResponse.operatorToken },
      { hostCredentialToken: `pw_host_${"A".repeat(43)}` },
      { projectRoot: "/srv/planweave" },
      { command: "curl https://evil.example" },
      { nested: { codeSha256: "a".repeat(64) } }
    ]) {
      expect(() => assertSetupViewRedacted(value)).toThrow("setup_view_not_redacted");
    }

    expect(exampleHostBootstrapEnrollmentSecret.kind).toBe("setup_code");
    expect(() =>
      hostBootstrapEnrollmentSecretSchema.parse({
        ...exampleHostBootstrapEnrollmentSecret,
        hostEnrollmentCode: `pw_enroll_${"A".repeat(43)}`
      })
    ).toThrow();
    expect(() =>
      hostBootstrapEnrollmentSecretSchema.parse({
        schemaVersion: "workspace-setup/v1",
        workspaceId: "workspace-demo-001",
        serverBaseUrl: "https://collab.example.com/",
        allowInsecureTransport: false,
        kind: "setup_code",
        setupCode: exampleSetupCode,
        operatorToken: exampleSetupCodeRedeemOperatorResponse.operatorToken
      })
    ).toThrow();
  });

  it("persists only digests on durable grants and records revocations", () => {
    expect(exampleSetupCodeGrant.codeSha256).toHaveLength(64);
    expect(exampleSetupCodeGrant).not.toHaveProperty("setupCode");
    expect(() =>
      setupCodeGrantSchema.parse({
        ...exampleSetupCodeGrant,
        setupCode: exampleSetupCode
      })
    ).toThrow();
    expect(() =>
      setupCodeGrantSchema.parse({
        ...exampleSetupCodeGrant,
        redeemedAt: "2030-01-01T00:20:00.000Z",
        redemptionSubjectId: null
      })
    ).toThrow();
    expect(exampleSetupCodeRevocation.purpose).toBe("device_session");
    expect(setupCodeTokenSchema.safeParse("not-a-setup-code").success).toBe(false);
    expect(setupCodeIssueResponseSchema.parse(exampleSetupCodeIssueResponse).displayOnce).toBe(
      true
    );
  });
});

function setupCodeRedeemDeviceResponseSchemaWithMixedSecrets(): void {
  setupCodeRedeemResponseSchema.parse({
    ...exampleSetupCodeRedeemDeviceResponse,
    operatorToken: exampleSetupCodeRedeemOperatorResponse.operatorToken
  });
}
