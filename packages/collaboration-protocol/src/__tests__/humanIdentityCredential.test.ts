import { describe, expect, it } from "vitest";
import {
  humanIdentityRenewRequestSchema,
  humanIdentityRevokeRequestSchema,
  humanPrincipalMergeRequestSchema
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

  it("rejects merge when both proofs are the same token", () => {
    expect(() =>
      humanPrincipalMergeRequestSchema.parse({
        schemaVersion: "human-identity/v1",
        sourceIdentityToken: exampleHumanIdentityToken,
        canonicalIdentityToken: exampleHumanIdentityToken
      })
    ).toThrow();
  });
});
