import { gateAcpCapabilities, type AcpCapabilitySnapshot } from "@planweave-ai/runtime";

export function acpCapabilitySnapshotTestValue(historyLoad = true): AcpCapabilitySnapshot {
  return gateAcpCapabilities(
    { required: [], optional: ["history-load", "session-close"] },
    {
      protocolVersion: 1,
      agentInfo: { name: "agent-host-test", version: "1.0.0" },
      agentCapabilities: {
        ...(historyLoad ? { loadSession: true } : {}),
        sessionCapabilities: { close: {} }
      }
    },
    { sessionStart: "new", connectionMode: "dedicated" }
  );
}
