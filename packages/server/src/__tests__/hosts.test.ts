import { describe, expect, it } from "vitest";
import {
  fleetHostAvailability,
  fleetHostExecutionProfileAvailability,
  hostExecutionProfileAvailability,
  type AgentHost
} from "../hosts.js";

function hostWithObservation(
  observation: NonNullable<AgentHost["readinessObservation"]>
): AgentHost {
  return {
    id: "host-fleet-1",
    displayName: "Fleet Host",
    capabilities: ["acp.codex"],
    capacity: 1,
    lastSeenAt: "2026-08-08T12:00:00.000Z",
    lastAcknowledgedSequence: 0,
    readinessObservation: observation
  };
}

const readyObservation: NonNullable<AgentHost["readinessObservation"]> = {
  workspaceMappings: [],
  acpProfiles: [
    {
      profileId: "codex-acp",
      agentId: "codex",
      displayName: "Codex",
      status: "ready",
      capabilities: ["acp.codex"]
    }
  ]
};

describe("fleet host readiness", () => {
  it("treats fleet hosts as available without workspace mapping", () => {
    const host = hostWithObservation(readyObservation);
    expect(fleetHostAvailability(host, true)).toEqual({ status: "available", reason: null });
  });

  it("uses fleet execution profile readiness when fleetUnbound is set", () => {
    const host = hostWithObservation(readyObservation);
    expect(
      hostExecutionProfileAvailability(host, {
        workspaceId: "workspace-1",
        online: true,
        agentId: "codex",
        agentProfileId: "codex-acp",
        requiredCapabilities: ["acp.codex"],
        fleetUnbound: true
      })
    ).toEqual({ status: "available", reason: null });
  });

  it("does not treat workspace mapping as Host readiness", () => {
    const host = hostWithObservation(readyObservation);
    expect(
      hostExecutionProfileAvailability(host, {
        workspaceId: "workspace-1",
        online: true,
        agentId: "codex",
        agentProfileId: "codex-acp",
        requiredCapabilities: ["acp.codex"]
      })
    ).toEqual({ status: "available", reason: null });
  });

  it("keeps fleet execution profile readiness when mapping is missing", () => {
    const host = hostWithObservation(readyObservation);
    expect(
      fleetHostExecutionProfileAvailability(host, {
        online: true,
        agentId: "codex",
        agentProfileId: "codex-acp",
        requiredCapabilities: ["acp.codex"]
      })
    ).toEqual({ status: "available", reason: null });
  });
});
