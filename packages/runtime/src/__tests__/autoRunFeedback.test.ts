import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimNext, getExecutionStatus, submitBlockResult, submitReviewResult } from "../index.js";
import { readJsonFile } from "../json.js";
import { readState } from "../state.js";
import { createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";
import { runContractAutoRunStep } from "./autoRunTestBuilders.js";

describe("Auto Run feedback executor failure recovery", () => {
  it("reopens the feedback envelope and clears currentFeedbackId when the feedback executor throws", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Please update tests.")
    });

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: {
        async runBlock() {
          throw new Error("block executor should not run for a feedback claim");
        },
        async runFeedback() {
          throw new Error("simulated feedback executor crash");
        }
      }
    });

    expect(step).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        reason: "Executor failed for feedback: simulated feedback executor crash"
      }
    });

    const state = await readState(init.workspace.stateFile);
    expect(state.currentFeedbackId).toBeNull();
    expect(state.feedback["FE-001"]?.status).toBe("open");

    const feedbackArtifact = await readJsonFile<{ status: string }>(
      join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json")
    );
    expect(feedbackArtifact.status).toBe("open");

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.currentFeedbackId).toBeNull();
    expect(status.openFeedback).toEqual([
      { feedbackId: "FE-001", sourceReviewBlockRef: "T-001#R-001", status: "open" }
    ]);

    const reclaim = await claimNext({ projectRoot: root });
    expect(reclaim).toMatchObject({
      kind: "feedback",
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      content: "Please update tests."
    });
  });
});
