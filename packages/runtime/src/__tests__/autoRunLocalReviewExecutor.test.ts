import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile } from "../json.js";
import { ExecutorCancelledError } from "../autoRun/executorShared.js";
import { runLocalReviewBlock, runLocalReviewFeedback } from "../autoRun/localReviewExecutor.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createContractLocalReviewAdapter, runContractAutoRunStep } from "./autoRunTestBuilders.js";

describe("Auto Run local review executor", () => {
  it("finalizes block and feedback metadata when local-review execution is cancelled", async () => {
    const blockWorkspace = await createTestWorkspace();
    const feedbackWorkspace = await createTestWorkspace();
    const profile = {
      adapter: "local-review" as const,
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60_000)"]
    };
    const executeProcess = () => Promise.reject(new ExecutorCancelledError());

    await expect(
      runLocalReviewBlock({
        projectRoot: blockWorkspace.init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#R-001",
          taskId: "T-001",
          blockId: "R-001",
          blockType: "review",
          effectiveExecutor: "cancelled-local-review"
        },
        prompt: "Review task",
        executorName: "cancelled-local-review",
        profile,
        tmuxEnabled: false,
        executeProcess
      })
    ).rejects.toBeInstanceOf(ExecutorCancelledError);
    await expect(
      runLocalReviewFeedback({
        projectRoot: feedbackWorkspace.init.workspace.rootPath,
        executionCwd: feedbackWorkspace.init.workspace.rootPath,
        planweaveHome: feedbackWorkspace.init.workspace.planweaveHome,
        workspaceResultsDir: feedbackWorkspace.init.workspace.resultsDir,
        claim: {
          kind: "feedback",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          content: "Address review feedback.",
          effectiveExecutor: "cancelled-local-review"
        },
        executorName: "cancelled-local-review",
        profile,
        tmuxEnabled: false,
        executeProcess
      })
    ).rejects.toBeInstanceOf(ExecutorCancelledError);

    const paths = [
      join(
        blockWorkspace.init.workspace.resultsDir,
        "T-001",
        "blocks",
        "R-001",
        "runs",
        "RUN-001",
        "metadata.json"
      ),
      join(feedbackWorkspace.init.workspace.resultsDir, "feedback-runs", "RUN-001", "metadata.json")
    ];
    await Promise.all(
      paths.map((path) =>
        expect(readJsonFile(path)).resolves.toMatchObject({
          finishedAt: expect.any(String),
          exitCode: 130,
          outcome: "cancelled",
          cancelled: true,
          stopped: true,
          failureReason: "Executor cancelled."
        })
      )
    );
  });

  it("local-review adapter submits review JSON without creating an agent session", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-local-review", {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          [
            "const result = {",
            "  reviewBlockRef: process.env.PLANWEAVE_REVIEW_BLOCK_REF,",
            "  taskId: process.env.PLANWEAVE_TASK_ID,",
            "  verdict: process.env.PLANWEAVE_BLOCK_ID === 'R-001' ? 'passed' : 'needs_changes',",
            "  content: 'passed by local review'",
            "};",
            "console.log(JSON.stringify(result));"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-local-review")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    await runContractAutoRunStep({
      projectRoot: root,
      executor: {
        async runBlock() {
          const reportPath = join(root, "implementation.md");
          await writeFile(reportPath, "implemented\n", "utf8");
          return { kind: "block", reportPath };
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      }
    });
    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractLocalReviewAdapter({
        projectRoot: root,
        executorName: "fake-local-review"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      adapterResult: { kind: "review", adapter: "local-review", agentSessionId: null },
      submitResult: { ref: "T-001#R-001", verdict: "passed", status: "completed" }
    });
    await expect(
      readJsonFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "R-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      )
    ).resolves.toMatchObject({
      executor: "fake-local-review",
      adapter: "local-review",
      agentSessionId: null,
      codexSessionId: null,
      exitCode: 0,
      artifactReference: {
        kind: "review",
        relativePath: "review-result.json",
        mediaType: "application/json"
      }
    });
  });

  it("verifies local-review feedback bytes before metadata success", async () => {
    const { init } = await createTestWorkspace();
    const profile = {
      adapter: "local-review" as const,
      command: "fake-local-review",
      args: []
    };
    const result = await runLocalReviewFeedback({
      projectRoot: init.workspace.rootPath,
      executionCwd: init.workspace.rootPath,
      planweaveHome: init.workspace.planweaveHome,
      workspaceResultsDir: init.workspace.resultsDir,
      claim: {
        kind: "feedback",
        feedbackId: "FE-001",
        sourceReviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        content: "Address feedback",
        effectiveExecutor: "fake-local-review"
      },
      executorName: "fake-local-review",
      profile,
      executeProcess: async () => ({
        stdout: "feedback handled\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        tmux: null
      })
    });
    expect(result).toMatchObject({
      kind: "feedback",
      reportPath: expect.stringContaining("report.md")
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "feedback-runs", "RUN-001", "metadata.json"))
    ).resolves.toMatchObject({
      outcome: "succeeded",
      artifactReference: {
        kind: "feedback",
        relativePath: "feedback-report.md",
        mediaType: "text/markdown"
      }
    });
  });
});
