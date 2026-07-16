import { describe, expect, it } from "vitest";
import {
  collectWorkspaceRunDurationInputs,
  needsLiveDurationClock,
  selectAgentTimeTotalMs,
  selectRunWallClockMs,
  selectTaskWallClockTotalMs
} from "../renderer/task-workspace/liveDuration";

describe("Task Workspace live duration selectors", () => {
  it("only marks unfinished active runs as needing a live clock", () => {
    expect(
      needsLiveDurationClock({
        active: true,
        finishedAt: null,
        startedAt: "2026-07-13T00:00:00.000Z"
      })
    ).toBe(true);
    expect(
      needsLiveDurationClock({
        active: true,
        finishedAt: "2026-07-13T00:00:05.000Z",
        startedAt: "2026-07-13T00:00:00.000Z"
      })
    ).toBe(false);
    expect(
      needsLiveDurationClock({
        active: false,
        finishedAt: null,
        startedAt: "2026-07-13T00:00:00.000Z"
      })
    ).toBe(false);
  });

  it("derives live wall-clock from startedAt and keeps terminal values static", () => {
    const startedAt = "2026-07-13T00:00:00.000Z";
    const nowMs = Date.parse("2026-07-13T00:00:10.000Z");
    expect(
      selectRunWallClockMs(
        {
          active: true,
          finishedAt: null,
          startedAt,
          wallClockMs: 1_000
        },
        nowMs
      )
    ).toBe(10_000);
    expect(
      selectRunWallClockMs(
        {
          active: false,
          finishedAt: "2026-07-13T00:00:05.000Z",
          startedAt,
          wallClockMs: 5_000
        },
        nowMs
      )
    ).toBe(5_000);
  });

  it("aggregates task wall-clock and agent time from run seeds without cloning workspace", () => {
    const startedAt = "2026-07-13T00:00:00.000Z";
    const nowMs = Date.parse("2026-07-13T00:00:08.000Z");
    const runs = [
      {
        active: true,
        finishedAt: null,
        startedAt,
        wallClockMs: 1_000
      },
      {
        active: false,
        finishedAt: "2026-07-13T00:00:03.000Z",
        startedAt,
        wallClockMs: 3_000
      }
    ];
    expect(
      selectTaskWallClockTotalMs({ activeRecordIds: ["r1"], runs }, nowMs)
    ).toBe(8_000);
    expect(selectAgentTimeTotalMs(runs, nowMs)).toEqual({
      totalMs: 11_000,
      includedRunCount: 2,
      missingRunCount: 0
    });
  });

  it("collects run duration inputs from a workspace-shaped aggregate", () => {
    const inputs = collectWorkspaceRunDurationInputs({
      activeRecordIds: ["T-001#B-001::RUN-001"],
      blocks: [
        {
          runs: [
            {
              active: true,
              run: {
                duration: {
                  finishedAt: null,
                  startedAt: "2026-07-13T00:00:00.000Z",
                  wallClockMs: 1_000
                }
              }
            }
          ]
        }
      ]
    });
    expect(inputs.activeRecordIds).toEqual(["T-001#B-001::RUN-001"]);
    expect(inputs.runs).toHaveLength(1);
    expect(needsLiveDurationClock(inputs.runs[0]!)).toBe(true);
  });
});
