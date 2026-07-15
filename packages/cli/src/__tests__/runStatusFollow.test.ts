import { describe, expect, it } from "vitest";
import { RunnerFollowDeduplicator, selectRunStatusFollowTarget } from "../commands/runStatus.js";

describe("run-status follow selection", () => {
  it("selects a newer exact CLI ACP record over a stale Desktop summary", () => {
    expect(
      selectRunStatusFollowTarget(
        {
          explanation: {
            latestRecordId: "T-001#R-001::RUN-002",
            latestRecordPath: "/results/review/RUN-002/metadata.json"
          },
          latestRuns: [
            {
              metadataPath: "/results/implementation/RUN-001/metadata.json",
              runnerKind: "acp",
              startedAt: "2026-07-11T00:00:00.000Z",
              finishedAt: "2026-07-11T00:00:01.000Z"
            },
            {
              metadataPath: "/results/review/RUN-002/metadata.json",
              runnerKind: "acp",
              startedAt: "2026-07-11T00:00:03.000Z",
              finishedAt: "2026-07-11T00:00:04.000Z"
            }
          ]
        },
        {
          runId: "DESKTOP-RUN-0001",
          updatedAt: "2026-07-11T00:00:02.000Z",
          latestRecordId: "T-001#B-001::RUN-001"
        }
      )
    ).toEqual({
      kind: "runner_record",
      metadataPath: "/results/review/RUN-002/metadata.json",
      timestamp: Date.parse("2026-07-11T00:00:04.000Z"),
      identity: "T-001#R-001::RUN-002"
    });
  });

  it("does not depend on latestRuns order when resolving the exact explanation path", () => {
    const target = selectRunStatusFollowTarget(
      {
        explanation: { latestRecordId: "new", latestRecordPath: "/new/metadata.json" },
        latestRuns: [
          {
            metadataPath: "/old/metadata.json",
            runnerKind: "acp",
            startedAt: "2026-07-11T00:00:00.000Z",
            finishedAt: null
          },
          {
            metadataPath: "/new/metadata.json",
            runnerKind: "acp",
            startedAt: "2026-07-11T00:00:02.000Z",
            finishedAt: null
          }
        ]
      },
      null
    );
    expect(target).toMatchObject({ kind: "runner_record", metadataPath: "/new/metadata.json" });
  });

  it("emits stable diagnostics and interaction state only once across polls", () => {
    const deduplicator = new RunnerFollowDeduplicator();
    const stateA = {
      events: [],
      diagnostics: [{ code: "truncated_tail" as const, line: 7, message: "partial event" }],
      interaction: { persisted: true, active: true, stale: false }
    };
    const stateB = {
      ...stateA,
      interaction: { persisted: true, active: false, stale: true }
    };
    expect(deduplicator.take(stateA)).toEqual(stateA);
    expect(deduplicator.take(stateA)).toEqual({ events: [], diagnostics: [], interaction: null });
    expect(deduplicator.take(stateB)).toEqual({
      events: [],
      diagnostics: [],
      interaction: stateB.interaction
    });
    expect(deduplicator.take(stateA)).toEqual({
      events: [],
      diagnostics: [],
      interaction: stateA.interaction
    });
  });
});
