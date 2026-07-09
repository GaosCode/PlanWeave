import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runCli,
  expectCompletedExampleStatus,
  expectNoOrphanValidation,
  repoRoot,
  cliWorkflowTimeoutMs,
  type ExampleStatus,
  type ValidationReport
} from "./support/cliTestHarness.js";

describe("STEP-1 CLI contract: claim and review", () => {
  it(
    "runs the block-level review feedback loop",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
      const env = { ...process.env, PLANWEAVE_HOME: home };
      const init = JSON.parse((await runCli(["init", "--project-graph", "--json"], env)).stdout);
      await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
        recursive: true,
        force: true
      });

      const validation = JSON.parse((await runCli(["validate", "--json"], env)).stdout);
      expect(validation.ok).toBe(true);

      expect(JSON.parse((await runCli(["claim-next"], env)).stdout)).toMatchObject({
        kind: "block",
        ref: "T-001#B-001"
      });
      expect((await runCli(["prompt", "T-001#B-001"], env)).stdout).toContain(
        "Create a small implementation report"
      );
      const implementation = join(home, "implementation.md");
      await writeFile(implementation, "Implemented.\n", "utf8");
      const submitResult = JSON.parse(
        (await runCli(["submit-result", "T-001#B-001", "--report", implementation, "--json"], env))
          .stdout
      ) as {
        ref: string;
        status: string;
      };
      expect(submitResult).toMatchObject({
        ref: "T-001#B-001",
        status: "completed"
      });

      expect(JSON.parse((await runCli(["claim", "--type", "review"], env)).stdout)).toMatchObject({
        kind: "block",
        ref: "T-001#R-001"
      });
      const review = join(home, "review.json");
      await writeFile(
        review,
        JSON.stringify({
          reviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          verdict: "needs_changes",
          content: "Adjust the implementation report."
        }),
        "utf8"
      );
      const needsChangesReview = JSON.parse(
        (await runCli(["submit-review", "T-001#R-001", "--result", review, "--json"], env)).stdout
      ) as {
        ref: string;
        verdict: string;
        status: string;
        feedbackCreated: boolean;
      };
      expect(needsChangesReview).toMatchObject({
        ref: "T-001#R-001",
        verdict: "needs_changes",
        status: "in_progress",
        feedbackCreated: true
      });
      expect(JSON.parse((await runCli(["claim-next"], env)).stdout)).toEqual({
        kind: "feedback",
        feedbackId: "FE-001",
        sourceReviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        content: "Adjust the implementation report.",
        effectiveExecutor: "manual"
      });
      const feedback = join(home, "feedback.md");
      await writeFile(feedback, "Adjusted.\n", "utf8");
      const submitFeedback = JSON.parse(
        (await runCli(["submit-feedback", "--report", feedback, "--json"], env)).stdout
      ) as {
        status: string;
        nextCommand: string;
      };
      expect(submitFeedback).toMatchObject({
        status: "accepted",
        nextCommand: "planweave claim-next"
      });

      expect(JSON.parse((await runCli(["claim-next"], env)).stdout)).toMatchObject({
        kind: "block",
        ref: "T-001#R-001",
        reason: "feedback_resolved"
      });
      await writeFile(
        review,
        JSON.stringify({
          reviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          verdict: "passed",
          content: "Passed."
        }),
        "utf8"
      );
      const passedReview = JSON.parse(
        (await runCli(["submit-review", "T-001#R-001", "--result", review, "--json"], env)).stdout
      ) as {
        ref: string;
        verdict: string;
        status: string;
        feedbackCreated: boolean;
      };
      expect(passedReview).toMatchObject({
        ref: "T-001#R-001",
        verdict: "passed",
        status: "completed",
        feedbackCreated: false
      });
      const status = JSON.parse((await runCli(["status", "--json"], env)).stdout) as ExampleStatus;
      expectCompletedExampleStatus(status);
      expectNoOrphanValidation(
        JSON.parse((await runCli(["validate", "--json"], env)).stdout) as ValidationReport
      );
    },
    cliWorkflowTimeoutMs
  );
});
