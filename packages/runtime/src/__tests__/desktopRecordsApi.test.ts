import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { writeJsonFile } from "../json.js";
import {
  getFeedbackRecords,
  getReviewAttempts,
  getRunRecord,
  listBlockRunRecords,
  listTaskFeedbackRecords,
  listTaskFeedbackRunRecords,
  resolveRunRecordArtifactPath,
  searchProject
} from "../desktop/index.js";
import { createArtifactReference } from "../autoRun/artifactReferenceContract.js";
import { readRunnerRecordReadModelForArtifact } from "../autoRun/runnerRecordReadModel.js";
import { normalizedRunnerEventSchema } from "../autoRun/normalizedEventContract.js";
import {
  claimNext,
  submitBlockResult,
  submitFeedback,
  submitReviewResult
} from "../taskManager/index.js";
import { readState, writeState } from "../state.js";
import {
  basicManifest,
  createTestWorkspace,
  writeReport,
  writeReviewResult
} from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop records API", () => {
  it("enumerates feedback run and state records only for the requested Task", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    for (const item of [
      { runId: "RUN-TASK-1", feedbackId: "FE-TASK-1", taskId: "T-001" },
      { runId: "RUN-TASK-2", feedbackId: "FE-TASK-2", taskId: "T-002" }
    ]) {
      const runDir = join(init.workspace.resultsDir, "feedback-runs", item.runId);
      await mkdir(runDir, { recursive: true });
      await writeJsonFile(join(runDir, "metadata.json"), {
        runId: item.runId,
        feedbackId: item.feedbackId,
        sourceReviewBlockRef: `${item.taskId}#R-001`,
        taskId: item.taskId,
        canvasId: "default",
        finishedAt: "2026-07-13T00:00:00.000Z"
      });
    }
    const state = await readState(init.workspace.stateFile);
    state.feedback["FE-TASK-1"] = {
      status: "resolved",
      sourceReviewBlockRef: "T-001#R-001",
      latestSubmissionId: null,
      content: "Task one"
    };
    state.feedback["FE-TASK-2"] = {
      status: "resolved",
      sourceReviewBlockRef: "T-002#R-001",
      latestSubmissionId: null,
      content: "Task two"
    };
    await writeState(init.workspace.stateFile, state);

    await expect(listTaskFeedbackRunRecords(root, "default", "T-001")).resolves.toEqual([
      expect.objectContaining({
        feedbackId: "FE-TASK-1",
        sourceReviewBlockRef: "T-001#R-001",
        taskId: "T-001"
      })
    ]);
    await expect(listTaskFeedbackRecords(root, "default", "T-001")).resolves.toEqual([
      expect.objectContaining({
        feedbackId: "FE-TASK-1",
        sourceReviewBlockRef: "T-001#R-001",
        content: "Task one"
      })
    ]);
  });

  it("validates feedback record Task scope before enumerating run metadata", async () => {
    const { root, init } = await createTestWorkspace();
    const invalidRunDir = join(init.workspace.resultsDir, "feedback-runs", "RUN-INVALID");
    await mkdir(invalidRunDir, { recursive: true });
    await writeJsonFile(join(invalidRunDir, "metadata.json"), {});

    await expect(listTaskFeedbackRunRecords(root, "default", "T-999")).rejects.toThrow(
      "Task 'T-999' does not exist in canvas 'default'."
    );
    await expect(listTaskFeedbackRunRecords(root, "default", "")).rejects.toThrow(/too small/i);
    await expect(listTaskFeedbackRunRecords(root, "missing-canvas", "T-001")).rejects.toThrow(
      "Project has no task canvas."
    );
  });

  it("lists newest run records first and removes terminal control codes from summaries", async () => {
    const { root, init } = await createTestWorkspace();
    const runsRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    await mkdir(join(runsRoot, "RUN-001"), { recursive: true });
    await mkdir(join(runsRoot, "RUN-002"), { recursive: true });
    await writeJsonFile(join(runsRoot, "RUN-001", "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#B-001",
      executor: "codex",
      adapter: "codex-exec",
      finishedAt: "2026-05-23T01:00:00.000Z",
      exitCode: 0
    });
    await writeJsonFile(join(runsRoot, "RUN-002", "metadata.json"), {
      runId: "RUN-002",
      ref: "T-001#B-001",
      executor: "opencode",
      adapter: "opencode-exec",
      finishedAt: "2026-05-23T02:00:00.000Z",
      exitCode: 0
    });
    await writeFile(
      join(runsRoot, "RUN-002", "stderr.log"),
      "\u001b[31mRead README.md\u001b[0m\n",
      "utf8"
    );

    const records = await listBlockRunRecords(root, "T-001#B-001");

    expect(records.map((record) => record.runId)).toEqual(["RUN-002", "RUN-001"]);
    expect(records[0]).toMatchObject({
      executor: "opencode",
      adapter: "opencode-exec",
      stderrSummary: "Read README.md"
    });
  });

  it("derives live OpenCode run record display text from streamed JSON before report exists", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeJsonFile(join(runDir, "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#B-001",
      executor: "opencode",
      adapter: "opencode-exec",
      startedAt: "2026-05-23T02:00:00.000Z",
      finishedAt: null,
      exitCode: null
    });
    await writeFile(
      join(runDir, "stdout.md"),
      [
        JSON.stringify({ type: "step_start", sessionID: "ses_live_123" }),
        JSON.stringify({
          type: "message_part_updated",
          part: { type: "text", text: "Live progress one." }
        }),
        JSON.stringify({
          type: "message_part_updated",
          part: { type: "text", text: "Live progress two." }
        })
      ].join("\n"),
      "utf8"
    );

    await expect(getRunRecord(root, "T-001#B-001::RUN-001")).resolves.toMatchObject({
      displayMarkdown: "Live progress one.\n\nLive progress two.",
      displayMarkdownSource: "live-output",
      reportMarkdown: "",
      stdoutSummary: "Live progress one.\n\nLive progress two."
    });
  });

  it("lists feedback run records from the source review block", async () => {
    const { root, init } = await createTestWorkspace();
    const feedbackRunDir = join(init.workspace.resultsDir, "feedback-runs", "RUN-001");
    await mkdir(feedbackRunDir, { recursive: true });
    await writeJsonFile(join(feedbackRunDir, "metadata.json"), {
      runId: "RUN-001",
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      executor: "opencode",
      adapter: "opencode-exec",
      projectRoot: root,
      executionCwd: root,
      agentSessionId: "ses_feedback_123",
      opencodeSessionId: "ses_feedback_123",
      tmuxSessionName: "planweave-feedback-RUN-001-abcd1234",
      tmuxAttachCommand: "tmux attach-session -t planweave-feedback-RUN-001-abcd1234",
      tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-feedback-RUN-001-abcd1234",
      startedAt: "2026-05-23T02:00:00.000Z",
      finishedAt: "2026-05-23T02:10:00.000Z",
      exitCode: 0
    });
    await writeFile(join(feedbackRunDir, "prompt.md"), "Fix the review feedback.\n", "utf8");
    await writeFile(join(feedbackRunDir, "stdout.md"), "Applied feedback fix.\n", "utf8");
    await writeFile(join(feedbackRunDir, "stderr.log"), "", "utf8");
    await writeFile(join(feedbackRunDir, "feedback-report.md"), "Feedback resolved.\n", "utf8");
    await writeJsonFile(join(feedbackRunDir, "heartbeat.json"), {
      status: "finished",
      pid: 12345,
      lastHeartbeatAt: "2026-05-23T02:09:59.000Z",
      finishedAt: "2026-05-23T02:10:00.000Z",
      exitCode: 0
    });

    await expect(listBlockRunRecords(root, "T-001#R-001")).resolves.toEqual([
      expect.objectContaining({
        kind: "feedback",
        recordId: "FE-001::RUN-001",
        ref: "T-001#R-001",
        feedbackId: "FE-001",
        sourceReviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        blockId: "R-001",
        executor: "opencode",
        adapter: "opencode-exec",
        agentSessionId: "ses_feedback_123",
        tmuxSessionId: "planweave-feedback-RUN-001-abcd1234",
        tmuxAttachCommand: "tmux attach-session -t planweave-feedback-RUN-001-abcd1234",
        tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-feedback-RUN-001-abcd1234",
        lastOutputAt: expect.any(String),
        heartbeatStatus: "finished",
        heartbeatPid: 12345,
        lastHeartbeatAt: "2026-05-23T02:09:59.000Z",
        lastActivityAt: expect.any(String),
        reportPath: expect.stringContaining("feedback-runs/RUN-001/feedback-report.md")
      })
    ]);
    await expect(getRunRecord(root, "FE-001::RUN-001")).resolves.toMatchObject({
      kind: "feedback",
      recordId: "FE-001::RUN-001",
      ref: "T-001#R-001",
      promptMarkdown: "Fix the review feedback.\n",
      reportMarkdown: "Feedback resolved.\n",
      displayMarkdown: "Feedback resolved.\n",
      displayMarkdownSource: "report",
      metadata: {
        feedbackId: "FE-001",
        sourceReviewBlockRef: "T-001#R-001"
      }
    });
  });

  it("searches run records, review attempts, and feedback records from runtime results/state", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "run-record.md", "desktop run record needle\n")
    });
    await writeJsonFile(
      join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-001",
        "metadata.json"
      ),
      {
        runId: "RUN-001",
        ref: "T-001#B-001",
        executor: "codex",
        adapter: "codex-exec",
        projectRoot: root,
        executionCwd: root,
        agentSessionId: "THREAD-123",
        codexSessionId: "THREAD-123",
        tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
        tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-abcd1234",
        tmuxReadOnlyAttachCommand:
          "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-abcd1234",
        exitCode: 0
      }
    );
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "desktop feedback needle")
    });

    await expect(listBlockRunRecords(root, "T-001#B-001")).resolves.toEqual([
      expect.objectContaining({
        ref: "T-001#B-001",
        recordId: "T-001#B-001::RUN-001",
        taskId: "T-001",
        blockId: "B-001",
        runId: "RUN-001",
        projectRoot: root,
        executionCwd: root,
        agentSessionId: "THREAD-123",
        codexSessionId: "THREAD-123",
        tmuxSessionId: "planweave-T-001-B-001-RUN-001-abcd1234",
        tmuxReadOnlyAttachCommand:
          "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-abcd1234",
        reportPath: expect.stringContaining("report.md")
      })
    ]);
    await expect(getRunRecord(root, "T-001#B-001::RUN-001")).resolves.toMatchObject({
      recordId: "T-001#B-001::RUN-001",
      ref: "T-001#B-001",
      runId: "RUN-001",
      executionCwd: root,
      agentSessionId: "THREAD-123",
      reportMarkdown: "desktop run record needle\n"
    });
    await expect(getReviewAttempts(root, "T-001#R-001")).resolves.toEqual([
      expect.objectContaining({
        ref: "T-001#R-001",
        attemptId: "REV-001",
        verdict: "needs_changes",
        contentPreview: "desktop feedback needle"
      })
    ]);
    await expect(getFeedbackRecords(root, "T-001#R-001")).resolves.toEqual([
      expect.objectContaining({
        feedbackId: "FE-001",
        sourceReviewBlockRef: "T-001#R-001",
        status: "open",
        content: "desktop feedback needle"
      })
    ]);

    expect(await searchProject(root, "run record needle")).toContainEqual(
      expect.objectContaining({
        kind: "run_record",
        ref: expect.stringContaining("report.md"),
        recordId: "T-001#B-001::RUN-001",
        path: expect.stringContaining("report.md")
      })
    );
    expect(await searchProject(root, "feedback needle")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "review_attempt",
          ref: expect.stringContaining("review-result.json"),
          targetRef: "T-001#R-001"
        }),
        expect.objectContaining({ kind: "feedback", ref: "FE-001", targetRef: "T-001#R-001" })
      ])
    );
  });

  it("lists review attempts and feedback records newest first", async () => {
    const { root } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 2 }));
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
      resultPath: await writeReviewResult(root, "needs_changes", "first feedback")
    });
    await claimNext({ projectRoot: root });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback-1.md", "first fix\n")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "second feedback")
    });
    await claimNext({ projectRoot: root });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback-2.md", "second fix\n")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "passed", "passed after fixes")
    });

    await expect(getReviewAttempts(root, "T-001#R-001")).resolves.toMatchObject([
      { attemptId: "REV-003", verdict: "passed", contentPreview: "passed after fixes" },
      { attemptId: "REV-002", verdict: "needs_changes", contentPreview: "second feedback" },
      { attemptId: "REV-001", verdict: "needs_changes", contentPreview: "first feedback" }
    ]);
    await expect(getFeedbackRecords(root, "T-001#R-001")).resolves.toMatchObject([
      {
        feedbackId: "FE-002",
        status: "resolved",
        latestSubmissionId: "FS-001",
        content: "second feedback"
      },
      {
        feedbackId: "FE-001",
        status: "resolved",
        latestSubmissionId: "FS-001",
        content: "first feedback"
      }
    ]);
  });

  it("gives CLI artifact and Desktop record adapters the same ACP model", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await mkdir(runDir, { recursive: true });
    const reportPath = join(runDir, "report.md");
    await writeFile(reportPath, "done\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      runnerKind: "acp",
      agentId: "codex",
      runId: "RUN-001",
      ref: "T-001#B-001"
    });
    const event = normalizedRunnerEventSchema.parse({
      version: "planweave.runner-event/v1",
      sequence: 1,
      timestamp: "2026-07-11T00:00:00.000Z",
      identity: {
        projectId: init.workspace.id,
        canvasId: "default",
        taskId: "T-001",
        blockId: "B-001",
        claimRef: "T-001#B-001",
        runId: "RUN-001",
        runOwner: "executor",
        runSessionId: null,
        desktopRunId: null,
        executorRunId: "RUN-001"
      },
      runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
      body: {
        kind: "message",
        role: "assistant",
        messageId: "message-1",
        chunk: true,
        content: "shared projection",
        redaction: { classes: [], replaced: 0 }
      }
    });
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");

    const desktop = await getRunRecord(root, "T-001#B-001::RUN-001");
    const cli = await readRunnerRecordReadModelForArtifact(reportPath);

    expect(desktop.runnerReadModel).toEqual(cli);
    expect(cli?.conversation).toEqual([expect.objectContaining({ content: "shared projection" })]);
  });

  it("resolves only verified in-record artifacts and rejects traversal or missing files", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await mkdir(runDir, { recursive: true });
    const reportPath = join(runDir, "report.md");
    await writeFile(reportPath, "verified artifact\n", "utf8");
    const reference = await createArtifactReference({
      rootDir: runDir,
      relativePath: "report.md",
      kind: "implementation"
    });

    await expect(
      resolveRunRecordArtifactPath(root, "T-001#B-001::RUN-001", reference)
    ).resolves.toBe(reportPath);
    await expect(
      resolveRunRecordArtifactPath(root, "T-001#B-001::RUN-001", {
        ...reference,
        // @ts-expect-error Exercises runtime validation of untrusted IPC input.
        relativePath: "../outside.md"
      })
    ).rejects.toThrow("Artifact path");

    await unlink(reportPath);
    await expect(
      resolveRunRecordArtifactPath(root, "T-001#B-001::RUN-001", reference)
    ).rejects.toThrow();
  });
});
