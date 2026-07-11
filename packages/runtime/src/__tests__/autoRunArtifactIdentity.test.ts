import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeArtifactBytes } from "../autoRun/artifactReferenceContract.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  claimNext,
  getExecutionStatus,
  submitBlockResult,
  submitReviewResult
} from "../taskManager/index.js";
import { runAutoRunStep } from "../taskManager/autoRun.js";
import type { ExecutorAdapter } from "../types.js";
import { createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

async function openFeedbackWorkspace() {
  const workspace = await createTestWorkspace();
  await claimNext({ projectRoot: workspace.root });
  await submitBlockResult({
    projectRoot: workspace.root,
    ref: "T-001#B-001",
    reportPath: await writeReport(workspace.root, "implementation.md")
  });
  await claimNext({ projectRoot: workspace.root });
  await submitReviewResult({
    projectRoot: workspace.root,
    ref: "T-001#R-001",
    resultPath: await writeReviewResult(
      workspace.root,
      "needs_changes",
      "Address the review finding."
    )
  });
  return workspace;
}

function unusedBlockRunner(): ExecutorAdapter["runBlock"] {
  return async () => {
    throw new Error("block should not run");
  };
}

async function expectFeedbackReleased(
  workspace: Awaited<ReturnType<typeof openFeedbackWorkspace>>
) {
  const status = await getExecutionStatus({ projectRoot: workspace.root });
  expect(status.currentFeedbackId).toBeNull();
  expect(status.openFeedback).toContainEqual({
    feedbackId: "FE-001",
    sourceReviewBlockRef: "T-001#R-001",
    status: "open"
  });
  await expect(
    readJsonFile(
      join(workspace.init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json")
    )
  ).resolves.toMatchObject({ status: "open" });
  await expect(
    readJsonFile(join(workspace.init.workspace.resultsDir, "T-001", "index.json"))
  ).resolves.toMatchObject({ feedbackStatusById: { "FE-001": "open" } });
}

describe("Auto Run persisted artifact identity", () => {
  it.each(["missing_claim_ref", "conflicting_claim_ref", "replaced_source"] as const)(
    "fails closed for ACP implementation %s",
    async (failure) => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    const executor: ExecutorAdapter = {
      async runBlock() {
        await mkdir(runDir, { recursive: true });
        const artifactReference = await materializeArtifactBytes({
          rootDir: runDir,
          relativePath: "report.md",
          kind: "implementation",
          content: "verified implementation\n"
        });
        await writeJsonFile(join(runDir, "metadata.json"), {
          runId: "RUN-001",
          ref: "T-001#B-001",
          ...(failure === "missing_claim_ref"
            ? {}
            : {
                claimRef:
                  failure === "conflicting_claim_ref" ? "T-001#B-WRONG" : "T-001#B-001"
              }),
          taskId: "T-001",
          blockId: "B-001",
          runnerKind: "acp",
          agentId: "codex",
          outcome: "succeeded",
          artifactReference
        });
        if (failure === "replaced_source") {
          await writeFile(join(runDir, "report.md"), "replaced implementation\n", "utf8");
        }
        return {
          kind: "block",
          reportPath: join(runDir, "report.md"),
          runId: "RUN-001",
          runnerKind: "acp",
          agentId: "codex"
        };
      },
      runFeedback: unusedBlockRunner()
    };

    await expect(runAutoRunStep({ projectRoot: root, executor })).resolves.toMatchObject({
      kind: "blocked",
      claim: { ref: "T-001#B-001" }
    });
    }
  );

  it.each(["missing_claim_ref", "conflicting_claim_ref", "symlink_source"] as const)(
    "fails closed for ACP review %s",
    async (failure) => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "implementation.md")
    });
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "R-001", "runs", "RUN-001");
    const verifiedResult = {
      reviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      verdict: "passed",
      content: "verified review"
    } as const;
    const executor: ExecutorAdapter = {
      async runBlock() {
        await mkdir(runDir, { recursive: true });
        const artifactReference = await materializeArtifactBytes({
          rootDir: runDir,
          relativePath: "review-result.json",
          kind: "review",
          content: `${JSON.stringify(verifiedResult)}\n`
        });
        await writeJsonFile(join(runDir, "metadata.json"), {
          runId: "RUN-001",
          ref: "T-001#R-001",
          ...(failure === "missing_claim_ref"
            ? {}
            : {
                claimRef:
                  failure === "conflicting_claim_ref" ? "T-001#R-WRONG" : "T-001#R-001"
              }),
          taskId: "T-001",
          blockId: "R-001",
          runnerKind: "acp",
          agentId: "codex",
          outcome: "succeeded",
          artifactReference
        });
        if (failure === "symlink_source") {
          const replacementPath = join(root, "replacement-review.json");
          await writeJsonFile(replacementPath, {
            ...verifiedResult,
            content: "replaced review"
          });
          await unlink(join(runDir, "review-result.json"));
          await symlink(replacementPath, join(runDir, "review-result.json"));
        }
        return {
          kind: "review",
          resultPath: join(runDir, "review-result.json"),
          runId: "RUN-001",
          runnerKind: "acp",
          agentId: "codex"
        };
      },
      runFeedback: unusedBlockRunner()
    };

    await expect(runAutoRunStep({ projectRoot: root, executor })).resolves.toMatchObject({
      kind: "blocked",
      claim: { ref: "T-001#R-001" }
    });
    }
  );

  it.each(
    ["missing_claim_ref", "conflicting_claim_ref", "conflicting_ref", "agent_mismatch"] as const
  )("fails closed for ACP feedback %s", async (failure) => {
    const workspace = await openFeedbackWorkspace();
    const runDir = join(workspace.init.workspace.resultsDir, "feedback-runs", "RUN-001");
    const executor: ExecutorAdapter = {
      runBlock: unusedBlockRunner(),
      async runFeedback() {
        await mkdir(runDir, { recursive: true });
        const artifactReference = await materializeArtifactBytes({
          rootDir: runDir,
          relativePath: "feedback-report.md",
          kind: "feedback",
          content: "verified feedback\n"
        });
        await writeJsonFile(join(runDir, "metadata.json"), {
          runId: "RUN-001",
          ref: failure === "conflicting_ref" ? "T-001#R-WRONG" : "T-001#R-001",
          ...(failure === "missing_claim_ref"
            ? {}
            : {
                claimRef:
                  failure === "conflicting_claim_ref" ? "T-001#R-WRONG" : "T-001#R-001"
              }),
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          runnerKind: "acp",
          agentId: failure === "agent_mismatch" ? "opencode" : "codex",
          outcome: "succeeded",
          artifactReference
        });
        return {
          kind: "feedback",
          reportPath: join(runDir, "feedback-report.md"),
          runId: "RUN-001",
          runnerKind: "acp",
          agentId: "codex"
        };
      }
    };

    await expect(runAutoRunStep({ projectRoot: workspace.root, executor })).resolves.toMatchObject({
      kind: "blocked"
    });
    await expectFeedbackReleased(workspace);
  });

  it("submits normal ACP review and feedback artifacts through verified intake", async () => {
    const reviewWorkspace = await createTestWorkspace();
    await claimNext({ projectRoot: reviewWorkspace.root });
    await submitBlockResult({
      projectRoot: reviewWorkspace.root,
      ref: "T-001#B-001",
      reportPath: await writeReport(reviewWorkspace.root, "implementation.md")
    });
    const reviewRunDir = join(
      reviewWorkspace.init.workspace.resultsDir,
      "T-001",
      "blocks",
      "R-001",
      "runs",
      "RUN-001"
    );
    const reviewResult = {
      reviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      verdict: "passed",
      content: "verified review"
    } as const;
    const reviewExecutor: ExecutorAdapter = {
      async runBlock() {
        await mkdir(reviewRunDir, { recursive: true });
        const artifactReference = await materializeArtifactBytes({
          rootDir: reviewRunDir,
          relativePath: "review-result.json",
          kind: "review",
          content: `${JSON.stringify(reviewResult)}\n`
        });
        await writeJsonFile(join(reviewRunDir, "metadata.json"), {
          runId: "RUN-001",
          ref: "T-001#R-001",
          claimRef: "T-001#R-001",
          taskId: "T-001",
          blockId: "R-001",
          runnerKind: "acp",
          agentId: "codex",
          outcome: "succeeded",
          artifactReference
        });
        return {
          kind: "review",
          resultPath: join(reviewRunDir, "review-result.json"),
          runId: "RUN-001",
          runnerKind: "acp",
          agentId: "codex"
        };
      },
      runFeedback: unusedBlockRunner()
    };
    await expect(
      runAutoRunStep({ projectRoot: reviewWorkspace.root, executor: reviewExecutor })
    ).resolves.toMatchObject({ kind: "submitted", submitResult: { status: "completed" } });

    const feedbackWorkspace = await openFeedbackWorkspace();
    const feedbackRunDir = join(
      feedbackWorkspace.init.workspace.resultsDir,
      "feedback-runs",
      "RUN-001"
    );
    const feedbackExecutor: ExecutorAdapter = {
      runBlock: unusedBlockRunner(),
      async runFeedback() {
        await mkdir(feedbackRunDir, { recursive: true });
        const artifactReference = await materializeArtifactBytes({
          rootDir: feedbackRunDir,
          relativePath: "feedback-report.md",
          kind: "feedback",
          content: "verified feedback\n"
        });
        await writeJsonFile(join(feedbackRunDir, "metadata.json"), {
          runId: "RUN-001",
          ref: "T-001#R-001",
          claimRef: "T-001#R-001",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          runnerKind: "acp",
          agentId: "codex",
          outcome: "succeeded",
          artifactReference
        });
        return {
          kind: "feedback",
          reportPath: join(feedbackRunDir, "feedback-report.md"),
          runId: "RUN-001",
          runnerKind: "acp",
          agentId: "codex"
        };
      }
    };
    await expect(
      runAutoRunStep({ projectRoot: feedbackWorkspace.root, executor: feedbackExecutor })
    ).resolves.toMatchObject({ kind: "submitted", submitResult: { status: "accepted" } });
  });

  it.each([
    ["runId", "RUN-WRONG"],
    ["ref", "T-001#B-WRONG"],
    ["taskId", "T-WRONG"],
    ["blockId", "B-WRONG"]
  ] as const)("fails closed for implementation metadata with wrong %s", async (field, value) => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    const executor: ExecutorAdapter = {
      async runBlock() {
        await mkdir(runDir, { recursive: true });
        const artifactReference = await materializeArtifactBytes({
          rootDir: runDir,
          relativePath: "report.md",
          kind: "implementation",
          content: "verified implementation\n"
        });
        await writeJsonFile(join(runDir, "metadata.json"), {
          runId: "RUN-001",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          adapter: "codex-exec",
          outcome: "succeeded",
          artifactReference,
          [field]: value
        });
        return {
          kind: "block",
          reportPath: join(runDir, "report.md"),
          runId: "RUN-001",
          adapter: "codex-exec"
        };
      },
      runFeedback: async () => {
        throw new Error("feedback should not run");
      }
    };

    await expect(runAutoRunStep({ projectRoot: root, executor })).resolves.toMatchObject({
      kind: "blocked",
      claim: { kind: "blocked", ref: "T-001#B-001" }
    });
  });

  it.each([
    "missing",
    "corrupt",
    "wrong_feedback",
    "wrong_review",
    "wrong_task"
  ] as const)("releases feedback after %s metadata validation fails", async (failure) => {
    const workspace = await openFeedbackWorkspace();
    const runDir = join(workspace.init.workspace.resultsDir, "feedback-runs", "RUN-001");
    const executor: ExecutorAdapter = {
      runBlock: unusedBlockRunner(),
      async runFeedback() {
        await mkdir(runDir, { recursive: true });
        const artifactReference = await materializeArtifactBytes({
          rootDir: runDir,
          relativePath: "feedback-report.md",
          kind: "feedback",
          content: "verified feedback\n"
        });
        if (failure === "corrupt") {
          await writeFile(join(runDir, "metadata.json"), "{", "utf8");
        } else if (failure !== "missing") {
          await writeJsonFile(join(runDir, "metadata.json"), {
            runId: "RUN-001",
            feedbackId: failure === "wrong_feedback" ? "FE-WRONG" : "FE-001",
            sourceReviewBlockRef: failure === "wrong_review" ? "T-001#R-WRONG" : "T-001#R-001",
            taskId: failure === "wrong_task" ? "T-WRONG" : "T-001",
            adapter: "codex-exec",
            outcome: "succeeded",
            artifactReference
          });
        }
        return {
          kind: "feedback",
          reportPath: join(runDir, "feedback-report.md"),
          runId: "RUN-001",
          adapter: "codex-exec"
        };
      }
    };

    await expect(runAutoRunStep({ projectRoot: workspace.root, executor })).resolves.toMatchObject({
      kind: "blocked",
      claim: { kind: "blocked" }
    });
    await expectFeedbackReleased(workspace);
  });

  it("releases feedback when submission fails after successful verification", async () => {
    const workspace = await openFeedbackWorkspace();
    const runDir = join(workspace.init.workspace.resultsDir, "feedback-runs", "RUN-001");
    const submissionsPath = join(
      workspace.init.workspace.resultsDir,
      "T-001",
      "feedback",
      "FE-001",
      "submissions"
    );
    await writeFile(submissionsPath, "not a directory", "utf8");
    const executor: ExecutorAdapter = {
      runBlock: unusedBlockRunner(),
      async runFeedback() {
        await mkdir(runDir, { recursive: true });
        const artifactReference = await materializeArtifactBytes({
          rootDir: runDir,
          relativePath: "feedback-report.md",
          kind: "feedback",
          content: "verified feedback\n"
        });
        await writeJsonFile(join(runDir, "metadata.json"), {
          runId: "RUN-001",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          adapter: "codex-exec",
          outcome: "succeeded",
          artifactReference
        });
        return {
          kind: "feedback",
          reportPath: join(runDir, "feedback-report.md"),
          runId: "RUN-001",
          adapter: "codex-exec"
        };
      }
    };

    await expect(runAutoRunStep({ projectRoot: workspace.root, executor })).resolves.toMatchObject({
      kind: "blocked",
      claim: { kind: "blocked" }
    });
    await expectFeedbackReleased(workspace);
    await expect(readFile(submissionsPath, "utf8")).resolves.toBe("not a directory");
  });
});
