import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { writeJsonFile } from "../json.js";
import { getFeedbackRecords, getReviewAttempts, getRunRecord, listBlockRunRecords, searchProject } from "../desktop/index.js";
import { claimNext, submitBlockResult, submitReviewResult } from "../taskManager/index.js";
import { createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop records API", () => {
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
    await writeFile(join(runsRoot, "RUN-002", "stderr.log"), "\u001b[31mRead README.md\u001b[0m\n", "utf8");

    const records = await listBlockRunRecords(root, "T-001#B-001");

    expect(records.map((record) => record.runId)).toEqual(["RUN-002", "RUN-001"]);
    expect(records[0]).toMatchObject({
      executor: "opencode",
      adapter: "opencode-exec",
      stderrSummary: "Read README.md"
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
    await writeJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#B-001",
      executor: "codex",
      adapter: "codex-exec",
      projectRoot: root,
      executionCwd: root,
      agentSessionId: "THREAD-123",
      codexSessionId: "THREAD-123",
      exitCode: 0
    });
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#C-001",
      reportPath: await writeReport(root, "check-record.md", "check complete\n")
    });
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
        expect.objectContaining({ kind: "review_attempt", ref: expect.stringContaining("review-result.json"), targetRef: "T-001#R-001" }),
        expect.objectContaining({ kind: "feedback", ref: "FE-001", targetRef: "T-001#R-001" })
      ])
    );
  });
});
