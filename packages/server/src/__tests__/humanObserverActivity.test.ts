import { describe, expect, it } from "vitest";
import { humanObserverEventSchema } from "@planweave-ai/collaboration-protocol/activity/observer";
import { observerEventForDispatchProgress } from "../humanObserverActivity.js";

describe("observerEventForDispatchProgress", () => {
  it("projects dispatch progress as a canvas-scoped remote_run observer event", () => {
    expect(
      humanObserverEventSchema.parse({
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 2,
        previousCursor: 1,
        occurredAt: "2026-09-04T00:00:00.000Z",
        ...observerEventForDispatchProgress({
          dispatchId: "dispatch-1",
          canvasId: "default",
          blockRef: "T-001#B-001"
        })
      })
    ).toMatchObject({
      kind: "remote_run",
      remoteRunStatus: "progress",
      dispatchId: "dispatch-1",
      workItem: { kind: "block", canvasId: "default", blockRef: "T-001#B-001" }
    });
  });
});
