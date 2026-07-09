import { describe, expect, it } from "vitest";
import { validateExecutionReadiness } from "../graph/executionReadiness.js";
import { writeJsonFile } from "../json.js";
import type { RuntimeState } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

function state(overrides: Partial<RuntimeState>): RuntimeState {
  return {
    currentRefs: [],
    currentFeedbackId: null,
    currentReviewBlockRef: null,
    tasks: {},
    blocks: {},
    feedback: {},
    ...overrides
  };
}

describe("validateExecutionReadiness", () => {
  it("reports ready execution when the next implementation block is claimable", async () => {
    const { root } = await createTestWorkspace();

    const result = await validateExecutionReadiness({ projectRoot: root });

    expect(result.ok).toBe(true);
    expect(result.nextClaimable).toEqual(["T-001#B-001"]);
    expect(result.summary).toMatchObject({
      taskCount: 1,
      blockCount: 2,
      readyBlockCount: 1,
      currentRefCount: 0,
      openFeedbackCount: 0,
      errorCount: 0
    });
  });

  it("reports active current work and open feedback as warnings", async () => {
    const { init, root } = await createTestWorkspace();
    await writeJsonFile(
      init.workspace.stateFile,
      state({
        currentRefs: ["T-001#B-001"],
        currentFeedbackId: "FE-001",
        blocks: {
          "T-001#B-001": { status: "in_progress" },
          "T-001#R-001": { status: "planned" }
        },
        feedback: {
          "FE-001": {
            status: "open",
            sourceReviewBlockRef: "T-001#R-001",
            latestSubmissionId: null,
            content: "Please revise the implementation."
          }
        }
      })
    );

    const result = await validateExecutionReadiness({ projectRoot: root });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "current_work_active",
          severity: "warning",
          suggestedTool: "get_status"
        }),
        expect.objectContaining({
          code: "open_feedback_pending",
          severity: "warning",
          suggestedTool: "get_status"
        })
      ])
    );
  });

  it("fails when execution is incomplete and no block is claimable", async () => {
    const { init, root } = await createTestWorkspace();
    await writeJsonFile(
      init.workspace.stateFile,
      state({
        blocks: {
          "T-001#B-001": { status: "blocked", blockedReason: "external dependency" },
          "T-001#R-001": { status: "planned" }
        }
      })
    );

    const result = await validateExecutionReadiness({ projectRoot: root });

    expect(result.ok).toBe(false);
    expect(result.nextClaimable).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "no_ready_blocks",
        severity: "error",
        suggestedTool: "validate_project"
      })
    );
  });
});
