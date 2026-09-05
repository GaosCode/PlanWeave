import { describe, expect, it } from "vitest";
import type { RemoteRunnerEventFragment } from "@planweave-ai/agent-host-protocol";
import { projectRemoteAcpReplay } from "../autoRun/remoteAcpEventProjection.js";
import { projectRemoteAcpTelemetry } from "../autoRun/remoteAcpTelemetry.js";

function replay(fragments: RemoteRunnerEventFragment[], executionAttemptId = "attempt-1") {
  return projectRemoteAcpReplay({
    eventProtocolVersion: 2,
    executionAttemptId,
    events: fragments.map((fragment, index) => ({
      eventVersion: 2,
      cursor: index + 1,
      sourceSequence: index + 1,
      timestamp: "2026-09-05T00:00:00.000Z",
      fragment
    }))
  });
}

const context: RemoteRunnerEventFragment = {
  kind: "runner_body",
  body: { kind: "usage_update", usedTokens: 200, contextWindowTokens: 1000, cost: null }
};
const cumulative: RemoteRunnerEventFragment = {
  kind: "engine_evidence",
  evidence: {
    kind: "usage_snapshot",
    usage: {
      semantics: "cumulative_session_total",
      totalTokens: 4000,
      inputTokens: 3000,
      outputTokens: 1000,
      thoughtTokens: null,
      cachedReadTokens: null,
      cachedWriteTokens: null
    }
  }
};

describe("remote ACP telemetry", () => {
  it("keeps context occupancy and cumulative usage separate without summing snapshots", () => {
    const projection = replay([context, cumulative, cumulative]);
    expect(projection.timeline).toEqual([]);
    expect(projectRemoteAcpTelemetry(projection.events)).toMatchObject({
      currentContext: { usedTokens: 200, contextWindowTokens: 1000 },
      cumulativeUsage: { totalTokens: 4000 }
    });
    expect(projectRemoteAcpTelemetry(replay([cumulative]).events).currentContext).toBeNull();
  });

  it("accepts a reduced context snapshot after compaction and never leaks prior-attempt usage", () => {
    const compacted: RemoteRunnerEventFragment = {
      kind: "runner_body",
      body: { kind: "usage_update", usedTokens: 50, contextWindowTokens: 1000, cost: null }
    };
    expect(
      projectRemoteAcpTelemetry(replay([context, compacted]).events).currentContext?.usedTokens
    ).toBe(50);
    const prior = replay([context, cumulative]);
    const next = replay(
      [
        {
          kind: "engine_evidence",
          evidence: { kind: "session_started", sessionId: "new-session", loaded: false }
        }
      ],
      "attempt-2"
    );
    expect(projectRemoteAcpTelemetry([...prior.events, ...next.events])).toMatchObject({
      executionAttemptId: "attempt-2",
      sessionId: "new-session",
      currentContext: null,
      cumulativeUsage: null
    });
  });

  it("projects configuration bodies without inventing a local runner identity", () => {
    const configuration: RemoteRunnerEventFragment = {
      kind: "runner_body",
      body: {
        kind: "session_configuration_snapshot",
        phase: "initial",
        configuration: { modes: null, configOptions: [] }
      }
    };
    const projection = replay([configuration]);
    expect(projection.timeline).toEqual([]);
    expect(projectRemoteAcpTelemetry(projection.events).actualConfiguration).toMatchObject({
      available: false
    });
  });
});
