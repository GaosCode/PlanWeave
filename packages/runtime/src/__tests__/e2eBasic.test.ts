import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../initWorkspace.js";
import { validatePackage } from "../validatePackage.js";
import {
  claimNext,
  getExecutionStatus,
  submitBlockResult,
  submitFeedback,
  submitReviewResult
} from "../taskManager/index.js";
import { createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("basic example package", () => {
  it("runs the documented block/review/feedback loop to implemented", async () => {
    const { root, init } = await createTestWorkspace();
    await cp(resolve(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    expect((await validatePackage({ projectRoot: root })).ok).toBe(true);
    expect(await claimNext({ projectRoot: root })).toMatchObject({
      kind: "block",
      ref: "T-001#B-001"
    });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "impl.md")
    });
    expect(await claimNext({ projectRoot: root })).toMatchObject({
      kind: "block",
      ref: "T-001#R-001"
    });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Tighten the report.")
    });
    expect(await claimNext({ projectRoot: root })).toMatchObject({
      kind: "feedback",
      content: "Tighten the report."
    });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback.md", "Report tightened.\n")
    });
    expect(await claimNext({ projectRoot: root })).toMatchObject({
      kind: "block",
      ref: "T-001#R-001",
      reason: "feedback_resolved"
    });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "passed", "Passed.")
    });

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.counts.tasks.implemented).toBe(1);
  });

  it("initializes an empty v1 workspace before an example package is copied in", async () => {
    const { root } = await createTestWorkspace();
    const result = await initWorkspace({ projectRoot: root });

    expect(result.created).toBe(false);
  });
});
