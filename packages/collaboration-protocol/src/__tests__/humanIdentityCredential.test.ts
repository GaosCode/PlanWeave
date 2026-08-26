import { describe, expect, it } from "vitest";
import {
  humanIdentityRecoverRequestSchema,
  humanIdentityRenewRequestSchema,
  humanIdentityRevokeRequestSchema,
  humanPrincipalMergeRequestSchema,
  humanPrincipalMergeResponseSchema
} from "../humanIdentityCredential.js";
import { exampleHumanIdentityToken } from "../fixtures/collaboration.js";

describe("human identity credential contracts", () => {
  it("requires a human identity token for renew and revoke", () => {
    expect(
      humanIdentityRenewRequestSchema.parse({
        schemaVersion: "human-identity/v1",
        identityToken: exampleHumanIdentityToken
      }).identityToken
    ).toBe(exampleHumanIdentityToken);
    expect(() =>
      humanIdentityRenewRequestSchema.parse({
        schemaVersion: "human-identity/v1",
        identityToken: "pw_hdev_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      })
    ).toThrow();
    expect(
      humanIdentityRevokeRequestSchema.parse({
        schemaVersion: "human-identity/v1",
        identityToken: exampleHumanIdentityToken,
        reason: "lost device"
      }).reason
    ).toBe("lost device");
  });

  it("recovers an identity credential from a device token", () => {
    expect(
      humanIdentityRecoverRequestSchema.parse({
        schemaVersion: "human-identity/v1",
        existingDeviceToken: "pw_hdev_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      }).existingDeviceToken
    ).toMatch(/^pw_hdev_/);
  });

  it("rejects merge when both proofs are the same token", () => {
    expect(() =>
      humanPrincipalMergeRequestSchema.parse({
        schemaVersion: "human-identity/v1",
        sourceIdentityToken: exampleHumanIdentityToken,
        canonicalIdentityToken: exampleHumanIdentityToken
      })
    ).toThrow();
  });

  it("accepts an already-equivalent merge response without a new audit row", () => {
    expect(
      humanPrincipalMergeResponseSchema.parse({
        schemaVersion: "human-identity/v1",
        canonicalHumanPrincipalId: "human-c",
        alreadyEquivalent: true
      })
    ).toMatchObject({ alreadyEquivalent: true, canonicalHumanPrincipalId: "human-c" });
  });

  it("requires merge audit fields unless the principals are already equivalent", () => {
    expect(() =>
      humanPrincipalMergeResponseSchema.parse({
        schemaVersion: "human-identity/v1",
        canonicalHumanPrincipalId: "human-c"
      })
    ).toThrow();
  });
});
