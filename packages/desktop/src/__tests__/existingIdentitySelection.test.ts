import { describe, expect, it } from "vitest";
import {
  diagnoseOriginIdentity,
  IdentitySelectionError,
  selectExistingIdentityProof
} from "../main/collaboration/existingIdentitySelection.js";

const origin = "https://collab.example.com";
const now = new Date("2030-06-01T00:00:00.000Z");

describe("diagnoseOriginIdentity", () => {
  it("prefers the newest unexpired identity token for a single principal", () => {
    const proof = diagnoseOriginIdentity(
      [
        {
          profileId: "profile-old",
          origin,
          humanPrincipalId: "human-a",
          deviceToken: "pw_hdev_old",
          identityToken: "pw_hid_expired",
          identityExpiresAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        },
        {
          profileId: "profile-new",
          origin,
          humanPrincipalId: "human-a",
          deviceToken: "pw_hdev_new",
          identityToken: "pw_hid_valid",
          identityExpiresAt: "2031-01-01T00:00:00.000Z",
          updatedAt: "2030-01-02T00:00:00.000Z"
        }
      ],
      `${origin}/`,
      now
    );
    expect(proof).toEqual({
      kind: "identity",
      token: "pw_hid_valid",
      humanPrincipalId: "human-a",
      profileId: "profile-new",
      expiresAt: "2031-01-01T00:00:00.000Z"
    });
  });

  it("falls back to device recovery when the identity token is expired", () => {
    const proof = diagnoseOriginIdentity(
      [
        {
          profileId: "profile-a",
          origin,
          humanPrincipalId: "human-a",
          deviceToken: "pw_hdev_valid",
          identityToken: "pw_hid_expired",
          identityExpiresAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-02T00:00:00.000Z"
        }
      ],
      `${origin}/`,
      now
    );
    expect(proof).toEqual({
      kind: "device_recovery",
      token: "pw_hdev_valid",
      humanPrincipalId: "human-a",
      profileId: "profile-a"
    });
  });

  it("does not send the first expired workspace token when a later valid token exists", () => {
    const proof = selectExistingIdentityProof(
      [
        {
          profileId: "profile-expired",
          origin,
          humanPrincipalId: "human-a",
          deviceToken: "pw_hdev_expired",
          updatedAt: "2030-01-01T00:00:00.000Z"
        },
        {
          profileId: "profile-valid",
          origin,
          humanPrincipalId: "human-a",
          deviceToken: "pw_hdev_valid",
          updatedAt: "2030-01-02T00:00:00.000Z"
        }
      ],
      `${origin}/`,
      now
    );
    expect(proof).toEqual({
      kind: "device_recovery",
      token: "pw_hdev_valid",
      humanPrincipalId: "human-a"
    });
  });

  it("requires repair when the same origin has multiple principals", () => {
    const diagnosed = diagnoseOriginIdentity(
      [
        {
          profileId: "profile-a",
          origin,
          humanPrincipalId: "human-a",
          identityToken: "pw_hid_a",
          updatedAt: "2030-01-01T00:00:00.000Z"
        },
        {
          profileId: "profile-b",
          origin,
          humanPrincipalId: "human-b",
          identityToken: "pw_hid_b",
          updatedAt: "2030-01-02T00:00:00.000Z"
        }
      ],
      `${origin}/`,
      now
    );
    expect(diagnosed.kind).toBe("repair_required");
    expect(() =>
      selectExistingIdentityProof(
        [
          {
            profileId: "profile-a",
            origin,
            humanPrincipalId: "human-a",
            identityToken: "pw_hid_a",
            updatedAt: "2030-01-01T00:00:00.000Z"
          },
          {
            profileId: "profile-b",
            origin,
            humanPrincipalId: "human-b",
            identityToken: "pw_hid_b",
            updatedAt: "2030-01-02T00:00:00.000Z"
          }
        ],
        `${origin}/`,
        now
      )
    ).toThrow(IdentitySelectionError);
  });

  it("requires repair when a same-origin token has no proven principal", () => {
    expect(
      diagnoseOriginIdentity(
        [
          {
            profileId: "profile-unknown",
            origin,
            humanPrincipalId: null,
            deviceToken: "pw_hdev_unknown",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
        `${origin}/`,
        now
      ).kind
    ).toBe("repair_required");
  });
});
