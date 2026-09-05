import {
  engineEvidenceLeafSchema,
  type EngineEvidenceLeaf,
  type RemoteRunnerEventFragment
} from "@planweave-ai/agent-host-protocol";
import type { AgentHostRemoteExecutionRecord } from "./remoteAcpPorts.js";
export function remoteAcpEngineFragment(
  event: Extract<AgentHostRemoteExecutionRecord, { kind: "engine_event" }>["event"]
): RemoteRunnerEventFragment {
  switch (event.kind) {
    case "session_update":
      return { kind: "runner_body", body: event.body };
    case "terminal":
      return { kind: "engine_terminal", terminal: event.terminal };
    case "usage":
      return {
        kind: "engine_evidence",
        evidence: {
          kind: "usage_snapshot",
          usage: { semantics: "cumulative_session_total", ...event.usage }
        }
      };
    case "capability_snapshot":
      return {
        kind: "engine_evidence",
        evidence: {
          kind: "capability_snapshot",
          required: event.snapshot.required,
          negotiated: event.snapshot.negotiated,
          missing: event.snapshot.missing
        }
      };
    case "capabilities":
      return {
        kind: "engine_evidence",
        evidence: { kind: "capabilities", capabilities: event.capabilities }
      };
    case "session_started":
      return {
        kind: "engine_evidence",
        evidence: { kind: "session_started", sessionId: event.sessionId, loaded: event.loaded }
      };
    case "interaction":
      return {
        kind: "engine_evidence",
        evidence: engineEvidenceLeafSchema.parse({
          kind: "interaction",
          requestId: event.requestId,
          interaction: event.interaction,
          state: event.state,
          ...(event.outcome === undefined ? {} : { outcome: event.outcome })
        })
      };
    case "lifecycle":
      return {
        kind: "engine_evidence",
        evidence: { kind: "lifecycle", state: event.state } as EngineEvidenceLeaf
      };
  }
}
