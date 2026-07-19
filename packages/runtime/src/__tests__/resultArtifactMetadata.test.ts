import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeBlockRunIndex,
  readBlockRunIndexView,
  rebuildBlockRunIndex
} from "../autoRun/blockRunIndex.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  claimNext,
  submitBlockResult,
  submitFeedback,
  submitReviewResult
} from "../taskManager/index.js";
import {
  parseFeedbackSubmissionMetadata,
  readFeedbackSubmissionMetadataFile
} from "../taskManager/feedbackSubmissionMetadata.js";
import {
  parseImplementationRunMetadata,
  readImplementationRunMetadataFile
} from "../taskManager/implementationRunMetadata.js";
import {
  parseReviewAttemptMetadata,
  parseReviewResultArtifact,
  readReviewAttemptMetadataFile,
  readReviewResultArtifactFile
} from "../taskManager/reviewAttemptMetadata.js";
import { loadRuntime } from "../taskManager/runtimeContext.js";
import { computeWorkRevision } from "../taskManager/selectors.js";
import type { TaskResultIndex } from "../types.js";
import { createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

async function completeImplementation(root: string): Promise<void> {
  await claimNext({ projectRoot: root });
  await submitBlockResult({
    projectRoot: root,
    ref: "T-001#B-001",
    reportPath: await writeReport(root, "impl.md", "done\n")
  });
  await claimNext({ projectRoot: root });
}

async function readWorkRevision(root: string, reviewBlockRef = "T-001#R-001"): Promise<string> {
  const { graph, state } = await loadRuntime({ projectRoot: root });
  return computeWorkRevision(graph, state, reviewBlockRef);
}

describe("implementation run metadata contract", () => {
  it("accepts submitted and executor-enriched metadata", () => {
    const submitted = parseImplementationRunMetadata(
      {
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        runId: "RUN-001",
        submittedAt: "2026-05-25T00:00:00.000Z",
        reportHash: "abc",
        sourceReportPath: "/tmp/report.md"
      },
      "/tmp/metadata.json"
    );
    expect(submitted.ref).toBe("T-001#B-001");
    expect(submitted.reportHash).toBe("abc");

    const enriched = parseImplementationRunMetadata(
      {
        ref: "T-001#B-001",
        runId: "RUN-001",
        startedAt: "2026-05-25T00:00:00.000Z",
        finishedAt: null,
        outcome: "succeeded",
        adapter: "codex-exec",
        reportHash: "abc"
      },
      "/tmp/metadata.json"
    );
    expect(enriched.startedAt).toBe("2026-05-25T00:00:00.000Z");
    expect(enriched.finishedAt).toBeNull();
    expect((enriched as { outcome?: string }).outcome).toBe("succeeded");
  });

  it("rejects wrong-typed present fields and accepts incomplete empty objects", () => {
    expect(parseImplementationRunMetadata({}, "/tmp/metadata.json")).toEqual({});
    expect(() =>
      parseImplementationRunMetadata({ ref: 1 }, "/tmp/metadata.json")
    ).toThrow(/Implementation run metadata at \/tmp\/metadata\.json is invalid:.*ref/);
    expect(() =>
      parseImplementationRunMetadata(
        {
          artifactReference: {
            version: "planweave.artifact/v1",
            kind: "implementation",
            relativePath: "report.md",
            sha256: "x",
            sizeBytes: 1,
            mediaType: "text/plain"
          }
        },
        "/tmp/metadata.json"
      )
    ).toThrow(/artifactReference|mediaType/);
  });

  it("surfaces malformed JSON and non-missing I/O failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw-impl-meta-"));
    const badPath = join(dir, "bad.json");
    await writeFile(badPath, "{not-json", "utf8");
    await expect(readImplementationRunMetadataFile(badPath)).rejects.toThrow(
      /Implementation run metadata at .* is malformed JSON/
    );

    if (process.platform === "win32") {
      return;
    }
    const denied = join(dir, "denied.json");
    await writeFile(denied, "{}", "utf8");
    await chmod(denied, 0);
    try {
      await expect(readImplementationRunMetadataFile(denied)).rejects.toMatchObject({
        code: "EACCES"
      });
    } finally {
      await chmod(denied, 0o644);
    }
  });
});

describe("review attempt metadata contract", () => {
  it("parses attempt metadata and review-result artifacts", () => {
    const metadata = parseReviewAttemptMetadata(
      {
        reviewBlockRef: "T-001#R-001",
        attemptId: "REV-001",
        reviewedWorkRevision: "rev",
        resultHash: "hash",
        sourceResultPath: "/tmp/result.json",
        reviewedAt: "2026-05-25T00:00:00.000Z"
      },
      "/tmp/meta.json"
    );
    expect(metadata.attemptId).toBe("REV-001");
    expect(
      parseReviewResultArtifact(
        {
          reviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          verdict: "passed",
          content: "ok"
        },
        "/tmp/result.json"
      ).verdict
    ).toBe("passed");
  });

  it("rejects wrong-typed metadata and invalid review results", () => {
    expect(() =>
      parseReviewAttemptMetadata({ attemptId: 1 }, "/tmp/meta.json")
    ).toThrow(/Review attempt metadata at \/tmp\/meta\.json is invalid:.*attemptId/);
    expect(() =>
      parseReviewResultArtifact(
        {
          reviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          verdict: "maybe",
          content: "x"
        },
        "/tmp/result.json"
      )
    ).toThrow(/Review result at \/tmp\/result\.json is invalid/);
  });

  it("surfaces malformed JSON for metadata and result files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw-review-meta-"));
    const metadataPath = join(dir, "metadata.json");
    const resultPath = join(dir, "review-result.json");
    await writeFile(metadataPath, "{", "utf8");
    await writeFile(resultPath, "{", "utf8");
    await expect(readReviewAttemptMetadataFile(metadataPath)).rejects.toThrow(/malformed JSON/);
    await expect(readReviewResultArtifactFile(resultPath)).rejects.toThrow(/malformed JSON/);
  });
});

describe("feedback submission metadata contract", () => {
  it("accepts complete and incomplete identity sets", () => {
    expect(
      parseFeedbackSubmissionMetadata(
        {
          feedbackId: "FE-001",
          submissionId: "FS-001",
          sourceReviewBlockRef: "T-001#R-001",
          reportHash: "abc",
          submittedAt: "2026-05-25T00:00:00.000Z"
        },
        "/tmp/meta.json"
      ).submissionId
    ).toBe("FS-001");
    expect(parseFeedbackSubmissionMetadata({}, "/tmp/meta.json")).toEqual({});
  });

  it("rejects wrong-typed present fields and malformed JSON", async () => {
    expect(() =>
      parseFeedbackSubmissionMetadata({ feedbackId: 1 }, "/tmp/meta.json")
    ).toThrow(/Feedback submission metadata at \/tmp\/meta\.json is invalid:.*feedbackId/);
    const dir = await mkdtemp(join(tmpdir(), "pw-fs-meta-"));
    const path = join(dir, "metadata.json");
    await writeFile(path, "not-json", "utf8");
    await expect(readFeedbackSubmissionMetadataFile(path)).rejects.toThrow(/malformed JSON/);
  });
});

describe("persisted artifact reuse via trusted contracts", () => {
  it("reuses a persisted implementation run without creating a duplicate", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const runDir = join(runRoot, "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      submittedAt: "2026-05-25T00:00:00.000Z",
      reportHash: createHash("sha256").update("report\n").digest("hex"),
      sourceReportPath: "/tmp/original-report.md"
    });

    const reused = await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "retry.md", "report\n")
    });
    expect(reused).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    await expect(access(join(runRoot, "RUN-002"))).rejects.toThrow();
  });

  it("fails closed when present implementation metadata is malformed during reuse scan", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-001"
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "report\n", "utf8");
    await writeFile(join(runDir, "metadata.json"), '{"ref":1,"runId":"RUN-001"}', "utf8");

    await expect(
      submitBlockResult({
        projectRoot: root,
        ref: "T-001#B-001",
        reportPath: await writeReport(root, "report.md", "report\n")
      })
    ).rejects.toThrow(/Implementation run metadata at .* is invalid/);
  });

  it("reuses a persisted review attempt and skips incomplete candidates", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "passed", "Looks good.");
    const persistedResult = await readJsonFile(resultPath);
    const attemptRoot = join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts");
    // Incomplete candidate: empty directory only (missing metadata/result).
    await mkdir(join(attemptRoot, "REV-000"), { recursive: true });
    await mkdir(join(attemptRoot, "REV-001"), { recursive: true });
    await writeJsonFile(join(attemptRoot, "REV-001", "review-result.json"), persistedResult);
    await writeJsonFile(join(attemptRoot, "REV-001", "metadata.json"), {
      reviewBlockRef: "T-001#R-001",
      attemptId: "REV-001",
      reviewedWorkRevision: await readWorkRevision(root),
      resultHash: createHash("sha256").update(JSON.stringify(persistedResult)).digest("hex"),
      sourceResultPath: resultPath,
      reviewedAt: "2026-05-25T00:00:00.000Z"
    });

    const result = await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath
    });
    expect(result).toMatchObject({
      ref: "T-001#R-001",
      reviewAttemptId: "REV-001",
      verdict: "passed",
      status: "completed"
    });
    await expect(access(join(attemptRoot, "REV-002"))).rejects.toThrow();
  });

  it("fails closed on malformed review attempt metadata during reuse scan", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const attemptDir = join(
      init.workspace.resultsDir,
      "T-001",
      "reviews",
      "R-001",
      "attempts",
      "REV-001"
    );
    await mkdir(attemptDir, { recursive: true });
    await writeFile(join(attemptDir, "metadata.json"), '{"reviewBlockRef":1}', "utf8");
    await writeJsonFile(join(attemptDir, "review-result.json"), {
      reviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      verdict: "passed",
      content: "ok"
    });

    await expect(
      submitReviewResult({
        projectRoot: root,
        ref: "T-001#R-001",
        resultPath: await writeReviewResult(root, "passed", "Looks good.")
      })
    ).rejects.toThrow(/Review attempt metadata at .* is invalid/);
  });

  it("fails closed on malformed review-result.json during reuse scan", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const attemptDir = join(
      init.workspace.resultsDir,
      "T-001",
      "reviews",
      "R-001",
      "attempts",
      "REV-001"
    );
    await mkdir(attemptDir, { recursive: true });
    await writeJsonFile(join(attemptDir, "metadata.json"), {
      reviewBlockRef: "T-001#R-001",
      attemptId: "REV-001",
      reviewedWorkRevision: await readWorkRevision(root),
      reviewedAt: "2026-05-25T00:00:00.000Z"
    });
    await writeFile(join(attemptDir, "review-result.json"), '{"verdict":"passed"}', "utf8");

    await expect(
      submitReviewResult({
        projectRoot: root,
        ref: "T-001#R-001",
        resultPath: await writeReviewResult(root, "passed", "Looks good.")
      })
    ).rejects.toThrow(/Review result at .* is invalid/);
  });

  it("reuses a persisted feedback submission without creating a duplicate", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix the edge case.")
    });
    await claimNext({ projectRoot: root });
    const submissionRoot = join(
      init.workspace.resultsDir,
      "T-001",
      "feedback",
      "FE-001",
      "submissions"
    );
    const submissionDir = join(submissionRoot, "FS-001");
    await mkdir(submissionDir, { recursive: true });
    await writeFile(join(submissionDir, "report.md"), "Fixed edge case.\n", "utf8");
    await writeJsonFile(join(submissionDir, "metadata.json"), {
      feedbackId: "FE-001",
      submissionId: "FS-001",
      sourceReviewBlockRef: "T-001#R-001",
      reportHash: createHash("sha256").update("Fixed edge case.\n").digest("hex"),
      submittedAt: "2026-05-25T00:00:00.000Z"
    });

    const result = await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback-retry.md", "Fixed edge case.\n")
    });
    expect(result).toMatchObject({ feedbackId: "FE-001", submissionId: "FS-001" });
    await expect(access(join(submissionRoot, "FS-002"))).rejects.toThrow();
    await expect(
      readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).resolves.toMatchObject({
      latestFeedbackSubmissionByFeedback: { "FE-001": "FS-001" }
    });
  });

  it("fails closed on malformed feedback submission metadata during reuse scan", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix the edge case.")
    });
    await claimNext({ projectRoot: root });
    const badDir = join(
      init.workspace.resultsDir,
      "T-001",
      "feedback",
      "FE-001",
      "submissions",
      "FS-001"
    );
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "report.md"), "Fixed edge case.\n", "utf8");
    await writeFile(join(badDir, "metadata.json"), '{"feedbackId":1}', "utf8");
    await expect(
      submitFeedback({
        projectRoot: root,
        reportPath: await writeReport(root, "feedback-retry.md", "Fixed edge case.\n")
      })
    ).rejects.toThrow(/Feedback submission metadata at .* is invalid/);
  });
});

describe("block run index metadata extraction", () => {
  it("extracts chronology and artifact presence from trusted implementation metadata", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "pw-bri-"));
    // Path shape: results/<task>/blocks/<block>/runs
    const shapedRoot = join(runRoot, "T-001", "blocks", "B-001", "runs");
    const runDir = join(shapedRoot, "RUN-002");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      runId: "RUN-002",
      startedAt: "2026-05-25T01:00:00.000Z",
      finishedAt: null,
      submittedAt: "2026-05-25T02:00:00.000Z",
      reportHash: "abc"
    });
    // Incomplete candidate without metadata falls back to ordinal chronology.
    await mkdir(join(shapedRoot, "RUN-001"), { recursive: true });

    await rebuildBlockRunIndex(shapedRoot);
    const view = await readBlockRunIndexView(shapedRoot, { limit: 10 });
    expect(view.entries).toHaveLength(2);
    const run2 = view.entries.find((entry) => entry.runId === "RUN-002");
    expect(run2).toMatchObject({
      runId: "RUN-002",
      hasArtifact: true,
      stableIdentity: "T-001#B-001::RUN-002"
    });
    expect(run2?.orderedAt).toBe("2026-05-25T01:00:00.000Z");
  });

  it("fails closed when present run metadata is malformed", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "pw-bri-bad-"));
    const shapedRoot = join(runRoot, "T-001", "blocks", "B-001", "runs");
    const runDir = join(shapedRoot, "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "metadata.json"), '{"ref":1}', "utf8");

    await expect(rebuildBlockRunIndex(shapedRoot)).rejects.toThrow(
      /Implementation run metadata at .* is invalid/
    );
  });

  it("keeps empty-index behavior for an empty run root", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "pw-bri-empty-"));
    const shapedRoot = join(runRoot, "T-001", "blocks", "B-001", "runs");
    await initializeBlockRunIndex(shapedRoot);
    const view = await readBlockRunIndexView(shapedRoot, { limit: 10 });
    expect(view.entries).toEqual([]);
    expect(view.head).toBeNull();
    expect(view.latestArtifact).toBeNull();
  });
});
