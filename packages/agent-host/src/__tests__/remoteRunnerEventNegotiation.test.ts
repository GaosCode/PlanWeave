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
  it("selects v2 only from an explicit v2-only capability", () => {
    expect(
      selectRemoteRunnerEventProtocolVersion({
        available: true,
        acceptedVersions: [2],
        preferredVersion: 2,
        ...counters
      })
    ).toBe(2);
  });

  it.each([
    undefined,
    { available: false },
    { available: true, acceptedVersions: [1, 2], preferredVersion: 2, ...counters },
    { available: true, acceptedVersions: [2], preferredVersion: 3, ...counters }
  ])("fails closed for absent, unavailable, legacy, or malformed capability data", (value) => {
    expect(() => selectRemoteRunnerEventProtocolVersion(value)).toThrow(
      "remote_runner_event_v2_required"
    );
  });
});
