import { describe, expect, it } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { buildWorkItemViewModel } from "../renderer/collaboration/collaborationViewModels";
import {
  parseWorkItemKey,
  workItemKey,
  type CollaborationReadModelSnapshot
} from "../shared/collaborationReadModels";

const first: WorkItemRef = { kind: "block", canvasId: "a:b", blockRef: "T#B" };
const second: WorkItemRef = { kind: "block", canvasId: "a", blockRef: "b:T#B" };

function snapshotWithConflictingRuns(): CollaborationReadModelSnapshot {
  return {
    profileId: "profile-1",
    projectId: "project-1",
    canvasId: null,
    syncPhase: "ready",
    observerCursor: 2,
    members: [],
    hosts: [],
    assignmentsByWorkItem: {},
    workAuthorityByWorkItem: {},
    commentsByWorkItem: {},
    commentInvalidationVersionByWorkItem: {},
    activity: [],
    remoteRunsByDispatchId: {
      "dispatch-first": {
        dispatchId: "dispatch-first",
        projectId: "project-1",
        workItem: first,
        status: "progress",
        updatedAt: "2030-01-01T00:00:00.000Z"
      },
      "dispatch-second": {
        dispatchId: "dispatch-second",
        projectId: "project-1",
        workItem: second,
        status: "succeeded",
        updatedAt: "2030-01-01T00:01:00.000Z"
      }
    },
    mutationsById: {},
    lastError: null,
    loadingKinds: [],
    updatedAt: "2030-01-01T00:01:00.000Z"
  };
}

describe("renderer WorkItem identity", () => {
  it("roundtrips delimiters and Unicode through a strict tuple", () => {
    const items: WorkItemRef[] = [
      first,
      second,
      { kind: "task", canvasId: "canvas:one", taskId: "task:alpha" }
    ];

    for (const item of items) {
      expect(parseWorkItemKey(workItemKey(item))).toEqual(item);
    }
    expect(parseWorkItemKey("block:a:b:T#B")).toBeNull();
    expect(parseWorkItemKey('["task","画布:一","任务:α"]')).toBeNull();
    expect(parseWorkItemKey('["block","","T#B"]')).toBeNull();
    expect(parseWorkItemKey('["block","a",""]')).toBeNull();
    expect(parseWorkItemKey('["block","a","T#B","extra"]')).toBeNull();
    expect(parseWorkItemKey('{"kind":"block","canvasId":"a","blockRef":"T#B"}')).toBeNull();
    expect(parseWorkItemKey("null")).toBeNull();
  });

  it("keeps colliding legacy identities distinct in assignment and authority maps", () => {
    const firstKey = workItemKey(first);
    const secondKey = workItemKey(second);
    const assignments = new Map([
      [firstKey, { workItem: first, revision: 1 }],
      [secondKey, { workItem: second, revision: 2 }]
    ]);
    const authorities = new Map([
      [firstKey, { workItem: first, responsibilityRevision: 3 }],
      [secondKey, { workItem: second, responsibilityRevision: 4 }]
    ]);

    expect(firstKey).not.toBe(secondKey);
    expect(assignments.get(firstKey)).toEqual({ workItem: first, revision: 1 });
    expect(assignments.get(secondKey)).toEqual({ workItem: second, revision: 2 });
    expect(authorities.get(firstKey)?.responsibilityRevision).toBe(3);
    expect(authorities.get(secondKey)?.responsibilityRevision).toBe(4);
  });

  it("matches observer runs to each formerly colliding WorkItem", () => {
    const snapshot = snapshotWithConflictingRuns();

    expect(buildWorkItemViewModel({ workItem: first, snapshot }).remoteRuns).toMatchObject([
      { dispatchId: "dispatch-first" }
    ]);
    expect(buildWorkItemViewModel({ workItem: second, snapshot }).remoteRuns).toMatchObject([
      { dispatchId: "dispatch-second" }
    ]);
  });

  it("cannot turn an identifier into an object prototype key", () => {
    const item: WorkItemRef = {
      kind: "task",
      canvasId: "__proto__",
      taskId: "constructor"
    };
    const key = workItemKey(item);
    const index = Object.fromEntries([[key, item]]);

    expect(key).not.toBe("__proto__");
    expect(Object.getPrototypeOf(index)).toBe(Object.prototype);
    expect(index[key]).toEqual(item);
  });
});
