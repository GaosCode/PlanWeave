import { describe, expect, it } from "vitest";
import { selectRemoteRunnerEventProtocolVersion } from "../transport/agentHostClient.js";

const counters = {
  v1Accepted: 0,
  v2Accepted: 0,
  v1Degraded: 0,
  usageSnapshotsAccepted: 0,
  usageSnapshotRegressions: 0
};

describe("remote Runner event negotiation", () => {
  it("uses v2 only when the capability is available and explicitly preferred", () => {
    expect(selectRemoteRunnerEventProtocolVersion({ available: false })).toBe(1);
    expect(
      selectRemoteRunnerEventProtocolVersion({
        available: true,
        acceptedVersions: [1, 2],
        preferredVersion: 1,
        ...counters
      })
    ).toBe(1);
    expect(
      selectRemoteRunnerEventProtocolVersion({
        available: true,
        acceptedVersions: [1, 2],
        preferredVersion: 2,
        ...counters
      })
    ).toBe(2);
  });

  it("falls back to v1 for absent, malformed, or future capability data", () => {
    expect(selectRemoteRunnerEventProtocolVersion(undefined)).toBe(1);
    expect(
      selectRemoteRunnerEventProtocolVersion({
        available: true,
        acceptedVersions: [1, 2],
        preferredVersion: 3,
        ...counters
      })
    ).toBe(1);
  });
});
