import { describe, expect, it } from "vitest";
import { recordWorkspaceTarget } from "../renderer/task-workspace/useRecordWorkspaceNavigation";

const locator = {
  projectRoot: "/projects/authority",
  canvasId: "canvas-authority",
  recordId: "T-001#B-001::RUN-001",
  expectedBlockRef: "T-001#B-001"
};

describe("record workspace authority", () => {
  it("builds a strict target from the requested locator and authoritative record", () => {
    expect(
      recordWorkspaceTarget(locator, {
        recordId: locator.recordId,
        ref: "T-001#B-001",
        taskId: "T-001"
      })
    ).toEqual({
      projectRoot: "/projects/authority",
      canvasId: "canvas-authority",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      recordId: "T-001#B-001::RUN-001"
    });
  });

  it.each([
    [
      { recordId: "T-001#B-001::RUN-OTHER", ref: "T-001#B-001", taskId: "T-001" },
      "requested record identity"
    ],
    [
      { recordId: locator.recordId, ref: "T-001#B-OTHER", taskId: "T-001" },
      "requested block identity"
    ],
    [
      { recordId: locator.recordId, ref: "T-001#B-001", taskId: "T-OTHER" },
      "inconsistent task and block identities"
    ]
  ])("rejects mismatched record authority", (record, message) => {
    expect(() => recordWorkspaceTarget(locator, record)).toThrow(message);
  });
});
