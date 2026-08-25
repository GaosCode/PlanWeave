import { describe, expect, it } from "vitest";
import {
  IdentitySelectionError,
  selectExistingIdentityProof
} from "../main/collaboration/existingIdentitySelection.js";

const origin = "https://collab.example.com";

describe("selectExistingIdentityProof", () => {
  it("prefers the newest identity token for a single principal", () => {
    const proof = selectExistingIdentityProof(
      [
        {
          profileId: "profile-old",
          origin,
          humanPrincipalId: "human-a",
          deviceToken: "pw_hdev_old",
          identityToken: "pw_hid_expired",
          updatedAt: "2030-01-01T00:00:00.000Z"
        },
        {
          profileId: "profile-new",
          origin,
          humanPrincipalId: "human-a",
          deviceToken: "pw_hdev_new",
          identityToken: "pw_hid_valid",
          updatedAt: "2030-01-02T00:00:00.000Z"
        }
      ],
      `${origin}/`
    );
    expect(proof).toEqual({
      kind: "identity",
      token: "pw_hid_valid",
      humanPrincipalId: "human-a"
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
      `${origin}/`
    );
    expect(proof).toEqual({
      kind: "device_recovery",
      token: "pw_hdev_valid",
      humanPrincipalId: "human-a"
    });
  });

  it("fails closed when the same origin has multiple principals", () => {
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
        `${origin}/`
      )
    ).toThrow(IdentitySelectionError);
  });

  it("fails closed when a same-origin token has no proven principal", () => {
    expect(() =>
      selectExistingIdentityProof(
        [
          {
            profileId: "profile-unknown",
            origin,
            humanPrincipalId: null,
            deviceToken: "pw_hdev_unknown",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
        `${origin}/`
      )
    ).toThrow(IdentitySelectionError);
  });
});
