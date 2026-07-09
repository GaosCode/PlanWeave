import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimNext,
  createManualExecutorAdapter,
  getAutoRunStatus,
  submitBlockResult,
  submitReviewResult
} from "../index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import {
  createFormalManualCanvasWorkspace,
  runContractAutoRunStep
} from "./autoRunTestBuilders.js";

describe("Auto Run manual executor", () => {
  it("manual adapter claims a block, writes the rendered prompt artifact, and waits for manual submission", async () => {
    const { root, init } = await createTestWorkspace();
    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createManualExecutorAdapter({
        projectRoot: root,
        executorName: "manual"
      })
    });

    expect(step).toMatchObject({
      kind: "manual",
      claim: { kind: "block", ref: "T-001#B-001" },
      adapterResult: { kind: "manual", executor: "manual" }
    });
    if (step.kind !== "manual") {
      throw new Error("expected manual step");
    }
    await expect(access(step.adapterResult.promptPath)).resolves.toBeUndefined();
    await expect(readFile(step.adapterResult.promptPath, "utf8")).resolves.toContain(
      "# T-001#B-001: Implement task"
    );
    await expect(
      readJsonFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      )
    ).resolves.toMatchObject({
      runId: "RUN-001",
      ref: "T-001#B-001",
      executor: "manual",
      adapter: "manual",
      exitCode: null
    });
  });

  it("exposes tmux metadata in Auto Run status latest run summaries", async () => {
    const { root, init } = await createTestWorkspace();
    await runContractAutoRunStep({
      projectRoot: root,
      executor: createManualExecutorAdapter({
        projectRoot: root,
        executorName: "manual"
      })
    });

    const metadataPath = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-001",
      "metadata.json"
    );
    const metadata = await readJsonFile<Record<string, unknown>>(metadataPath);
    await writeJsonFile(metadataPath, {
      ...metadata,
      tmuxSessionName: "planweave-T-001-B-001-RUN-001-123abcd",
      tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-123abcd",
      tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-123abcd"
    });

    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      latestRuns: [
        expect.objectContaining({
          ref: "T-001#B-001",
          tmuxSessionName: "planweave-T-001-B-001-RUN-001-123abcd",
          tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-123abcd",
          tmuxReadOnlyAttachCommand:
            "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-123abcd"
        })
      ]
    });
  });

  it("routes feedback through the claim effective executor instead of the manifest default", async () => {
    const manifest = manifestTestBuilder()
      .withDefaultExecutor("manual")
      .withExecutor("feedback-runner", {
        adapter: "manual"
      })
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "feedback-runner" }))
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(
        root,
        "needs_changes",
        "Fix with the implementation executor."
      )
    });

    const feedbackStep = await runContractAutoRunStep({ projectRoot: root });

    expect(feedbackStep).toMatchObject({
      kind: "manual",
      claim: { kind: "feedback", feedbackId: "FE-001", effectiveExecutor: "feedback-runner" },
      adapterResult: { executor: "feedback-runner" }
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "feedback-runs", "RUN-001", "metadata.json"))
    ).resolves.toMatchObject({
      feedbackId: "FE-001",
      executor: "feedback-runner",
      adapter: "manual"
    });
  });

  it("manual adapter scopes next commands for formal project graph canvases with arbitrary package paths", async () => {
    const { root, workspace } = await createFormalManualCanvasWorkspace();
    const executor = createManualExecutorAdapter({
      projectRoot: workspace,
      executorName: "manual"
    });

    const implementationStep = await runContractAutoRunStep({
      projectRoot: workspace,
      executor
    });

    expect(implementationStep).toMatchObject({
      kind: "manual",
      adapterResult: {
        nextCommand:
          "planweave submit-result --canvas manual-canvas T-001#B-001 --report <report.md>"
      }
    });
    await submitBlockResult({
      projectRoot: workspace,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await runContractAutoRunStep({
      projectRoot: workspace,
      executor
    });
    await submitReviewResult({
      projectRoot: workspace,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix formal canvas work.")
    });

    const feedbackStep = await runContractAutoRunStep({
      projectRoot: workspace,
      executor
    });

    expect(feedbackStep).toMatchObject({
      kind: "manual",
      adapterResult: {
        nextCommand: "planweave submit-feedback --canvas manual-canvas --report <report.md>"
      }
    });
    await expect(getAutoRunStatus({ projectRoot: workspace })).resolves.toMatchObject({
      current: {
        refs: [],
        feedbackId: "FE-001",
        reviewBlockRef: "T-001#R-001"
      },
      explanation: {
        phase: "manual",
        currentRef: "FE-001",
        currentExecutor: "manual",
        latestRecordId: "FE-001::RUN-001",
        latestRecordPath: expect.stringContaining(
          join("feedback-runs", "RUN-001", "metadata.json")
        ),
        latestOutputSummary:
          "planweave submit-feedback --canvas manual-canvas --report <report.md>",
        nextAction: {
          kind: "submit_manual_result",
          command: "planweave submit-feedback --canvas manual-canvas --report <report.md>",
          ref: "FE-001"
        }
      },
      latestRuns: expect.arrayContaining([
        expect.objectContaining({
          kind: "feedback",
          ref: "FE-001",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          runId: "RUN-001",
          executor: "manual",
          adapter: "manual",
          status: "in_progress",
          promptPath: expect.stringContaining(join("feedback-runs", "RUN-001", "feedback.md")),
          metadataPath: expect.stringContaining(join("feedback-runs", "RUN-001", "metadata.json"))
        })
      ])
    });
  });
});
