import { describe, expect, it } from "vitest";
import { WORK_ASSIGNMENT_BATCH_MAX } from "../limits.js";
import {
  parseResolveWorkItemsResult,
  resolveWorkItemsRequestSchema,
  resolveWorkItemsResultSchema,
  workItemPackageFactsSchema
} from "../workPackageFacts.js";

const task = { kind: "task", canvasId: "canvas-a", taskId: "task-a" } as const;
const block = { kind: "block", canvasId: "canvas-a", blockRef: "task-a#block-a" } as const;
const evidence = {
  sourceRevision: "snapshot:revision-a",
  graphFingerprint: `pkg-${"a".repeat(64)}`
};

describe("work package facts contract", () => {
  it("accepts a bounded strict request", () => {
    expect(resolveWorkItemsRequestSchema.parse({ workItems: [task, block] })).toEqual({
      workItems: [task, block]
    });
    expect(() => resolveWorkItemsRequestSchema.parse({ workItems: [] })).toThrow();
    expect(() =>
      resolveWorkItemsRequestSchema.parse({
        workItems: Array.from({ length: WORK_ASSIGNMENT_BATCH_MAX + 1 }, () => task)
      })
    ).toThrow();
    expect(() =>
      resolveWorkItemsRequestSchema.parse({ workItems: [task], path: "/private" })
    ).toThrow();
  });

  it("keeps package facts strict and kind-specific", () => {
    expect(
      workItemPackageFactsSchema.parse({
        ...block,
        exists: true,
        taskId: "task-a",
        blockType: "implementation",
        requiredCapabilities: ["acp.codex"]
      })
    ).toMatchObject({ blockRef: block.blockRef, requiredCapabilities: ["acp.codex"] });
    expect(() =>
      workItemPackageFactsSchema.parse({
        ...task,
        exists: true,
        blockRef: block.blockRef,
        requiredCapabilities: []
      })
    ).toThrow();
  });

  it("binds result length, identity, and order to the request", () => {
    const facts = [
      { ...task, exists: true, requiredCapabilities: [] },
      {
        ...block,
        exists: true,
        taskId: "task-a",
        blockType: "implementation" as const,
        requiredCapabilities: ["acp.codex"]
      }
    ];
    expect(
      parseResolveWorkItemsResult({ workItems: [task, block] }, { ...evidence, facts })
    ).toEqual({
      ...evidence,
      facts
    });
    expect(() =>
      parseResolveWorkItemsResult({ workItems: [task, block] }, { ...evidence, facts: [facts[0]] })
    ).toThrow("length");
    expect(() =>
      parseResolveWorkItemsResult(
        { workItems: [task, block] },
        { ...evidence, facts: facts.toReversed() }
      )
    ).toThrow("identity and order");
    expect(() =>
      resolveWorkItemsResultSchema.parse({ ...evidence, facts, path: "/private" })
    ).toThrow();
  });
});
