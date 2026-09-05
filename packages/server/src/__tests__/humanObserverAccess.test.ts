import { describe, expect, it } from "vitest";
import { humanObserverEventSchema } from "@planweave-ai/collaboration-protocol/activity/observer";
import { humanObserverEventIsVisible } from "../humanObserverAccess.js";

const digest = "a".repeat(64);
const visibility = { kind: "canvases" as const, canvasIds: new Set(["visible"]) };

describe("humanObserverEventIsVisible", () => {
  it("delivers every event to project-scope readers", () => {
    const hidden = humanObserverEventSchema.parse({
      type: "human.observer.event",
      protocolVersion: 1,
      cursor: 2,
      previousCursor: 1,
      occurredAt: "2026-09-04T00:00:00.000Z",
      kind: "canvas",
      canvasId: "hidden",
      canvasRevision: 1,
      canvasContentDigest: digest
    });
    expect(humanObserverEventIsVisible(hidden, { kind: "project" })).toBe(true);
  });

  it("keeps membership, invitation, and project events for canvas-only readers", () => {
    for (const kind of ["invitation", "membership", "project"] as const) {
      const event = humanObserverEventSchema.parse({
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 2,
        previousCursor: 1,
        occurredAt: "2026-09-04T00:00:00.000Z",
        kind
      });
      expect(humanObserverEventIsVisible(event, visibility)).toBe(true);
    }
  });

  it("drops canvas, runtime, and work-item events that are not in the readable set", () => {
    const hiddenCanvas = humanObserverEventSchema.parse({
      type: "human.observer.event",
      protocolVersion: 1,
      cursor: 2,
      previousCursor: 1,
      occurredAt: "2026-09-04T00:00:00.000Z",
      kind: "canvas",
      canvasId: "hidden",
      canvasRevision: 1,
      canvasContentDigest: digest
    });
    const hiddenRuntime = humanObserverEventSchema.parse({
      type: "human.observer.event",
      protocolVersion: 1,
      cursor: 2,
      previousCursor: 1,
      occurredAt: "2026-09-04T00:00:00.000Z",
      kind: "runtime",
      canvasId: "hidden",
      runtimeRevision: 1
    });
    const hiddenAssignment = humanObserverEventSchema.parse({
      type: "human.observer.event",
      protocolVersion: 1,
      cursor: 2,
      previousCursor: 1,
      occurredAt: "2026-09-04T00:00:00.000Z",
      kind: "assignment",
      workItem: { kind: "task", canvasId: "hidden", taskId: "T-001" }
    });
    const visibleAssignment = humanObserverEventSchema.parse({
      type: "human.observer.event",
      protocolVersion: 1,
      cursor: 2,
      previousCursor: 1,
      occurredAt: "2026-09-04T00:00:00.000Z",
      kind: "assignment",
      workItem: { kind: "task", canvasId: "visible", taskId: "T-001" }
    });
    const comment = humanObserverEventSchema.parse({
      type: "human.observer.event",
      protocolVersion: 1,
      cursor: 2,
      previousCursor: 1,
      occurredAt: "2026-09-04T00:00:00.000Z",
      kind: "comment"
    });
    expect(humanObserverEventIsVisible(hiddenCanvas, visibility)).toBe(false);
    expect(humanObserverEventIsVisible(hiddenRuntime, visibility)).toBe(false);
    expect(humanObserverEventIsVisible(hiddenAssignment, visibility)).toBe(false);
    expect(humanObserverEventIsVisible(visibleAssignment, visibility)).toBe(true);
    expect(humanObserverEventIsVisible(comment, visibility)).toBe(false);
  });

  it("keeps remote-run progress for the readable canvas", () => {
    const progress = humanObserverEventSchema.parse({
      type: "human.observer.event",
      protocolVersion: 1,
      cursor: 2,
      previousCursor: 1,
      occurredAt: "2026-09-04T00:00:00.000Z",
      kind: "remote_run",
      remoteRunStatus: "progress",
      dispatchId: "dispatch-1",
      workItem: { kind: "block", canvasId: "visible", blockRef: "T-001#B-001" }
    });
    const hidden = humanObserverEventSchema.parse({
      ...progress,
      workItem: { kind: "block", canvasId: "hidden", blockRef: "T-001#B-001" }
    });
    expect(humanObserverEventIsVisible(progress, visibility)).toBe(true);
    expect(humanObserverEventIsVisible(hidden, visibility)).toBe(false);
  });
});
