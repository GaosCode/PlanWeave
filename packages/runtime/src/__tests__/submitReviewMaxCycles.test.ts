import * as fs from "node:fs/promises";
import { access, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claimNext,
  getExecutionStatus,
  resetMaxCycleReviewsForRetry,
  retryReview,
  submitBlockResult,
  submitReviewResult
} from "../taskManager/index.js";
import { loadPackage } from "../package/loadPackage.js";
import * as json from "../json.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { readState } from "../state.js";
import type { PlanPackageManifest, TaskResultIndex } from "../types.js";
import {
  basicManifest,
  createTestWorkspace,
  writeReport,
  writeReviewResult,
  writePromptFiles
} from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile) };
});

async function completeImplementation(root: string): Promise<void> {
  await claimNext({ projectRoot: root });
  await submitBlockResult({
    projectRoot: root,
    ref: "T-001#B-001",
    reportPath: await writeReport(root, "b.md")
  });
  await claimNext({ projectRoot: root });
}

describe("submitReviewResult max feedback cycles", () => {
  it("does not create feedback when retrying rewritten same-hash max-cycle review after retry reset", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "needs_changes", "No cycles allowed.");

    const first = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    await resetMaxCycleReviewsForRetry({ projectRoot: root, scope: { kind: "project" } });
    await claimNext({ projectRoot: root });
    await writeFile(
      resultPath,
      JSON.stringify({
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "needs_changes",
        content: "No cycles allowed."
      }),
      "utf8"
    );
    const future = new Date(Date.now() + 10_000);
    await utimes(resultPath, future, future);

    const retry = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(retry).toEqual(first);
    expect(status.currentRefs).toEqual([]);
    expect(status.currentFeedbackId).toBeNull();
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "completed",
      latestReviewAttemptId: "REV-001",
      activeFeedbackId: null,
      completionReason: "max_cycles_reached"
    });
    await expect(
      access(join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts", "REV-002"))
    ).rejects.toThrow();
    await expect(
      access(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001"))
    ).rejects.toThrow();
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-001" });
    expect(taskIndex.reviewCompletionReasonByBlock).toMatchObject({
      "T-001#R-001": "max_cycles_reached"
    });
    expect(taskIndex.counts).toMatchObject({ runs: 1, reviewAttempts: 1 });
    expect(taskIndex.counts?.feedbackEnvelopes).toBeUndefined();
  });

  it("enforces max feedback cycles in the Task Manager", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);

    const result = await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "No cycles allowed.")
    });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(result).toMatchObject({ verdict: "needs_changes", status: "completed" });
    expect(status.tasks[0].status).toBe("in_progress");
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      activeFeedbackId: null,
      completionReason: "max_cycles_reached"
    });
    expect(status.warnings.map((warning) => warning.code)).toContain("review_max_cycles_reached");
    expect(taskIndex.reviewCompletionReasonByBlock).toMatchObject({
      "T-001#R-001": "max_cycles_reached"
    });
    expect(taskIndex.warnings?.map((warning) => warning.code)).toContain(
      "review_max_cycles_reached"
    );
    expect(result).toMatchObject({
      completionReason: "max_cycles_reached",
      feedbackCreated: false,
      message: "No feedback envelope was created because max feedback cycles were reached."
    });
  });

  it("raises max feedback cycles and resets an exhausted review for retry", async () => {
    const { root } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "No cycles allowed.")
    });

    const retry = await retryReview({
      projectRoot: root,
      ref: "T-001#R-001",
      maxFeedbackCycles: 3
    });
    const status = await getExecutionStatus({ projectRoot: root });
    const { manifest } = await loadPackage(root);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    const reviewBlock =
      task?.type === "task" ? task.blocks.find((block) => block.id === "R-001") : null;

    expect(retry).toMatchObject({
      ref: "T-001#R-001",
      status: "ready",
      maxFeedbackCycles: 3,
      reset: true
    });
    expect(reviewBlock?.type).toBe("review");
    expect(reviewBlock?.type === "review" ? reviewBlock.review.maxFeedbackCycles : null).toBe(3);
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "ready",
      completionReason: null
    });
    expect(status.warnings.map((warning) => warning.code)).not.toContain(
      "review_max_cycles_reached"
    );
    await expect(claimNext({ projectRoot: root })).resolves.toMatchObject({
      kind: "block",
      ref: "T-001#R-001"
    });
  });

  it.each([
    { ref: "T-001#R-001", maxFeedbackCycles: -1, error: "non-negative integer" },
    { ref: "T-001#R-001", maxFeedbackCycles: 1.5, error: "non-negative integer" },
    { ref: "T-001#R-001", maxFeedbackCycles: Number.NaN, error: "non-negative integer" },
    { ref: "T-001#B-001", maxFeedbackCycles: 3, error: "not a review block" },
    { ref: "T-001#R-999", maxFeedbackCycles: 3, error: "does not exist" }
  ])("rejects invalid retry without changing files: $ref / $maxFeedbackCycles", async ({
    ref,
    maxFeedbackCycles,
    error
  }) => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);
    const paths = [
      init.workspace.manifestFile,
      init.workspace.stateFile,
      join(init.workspace.resultsDir, "T-001", "index.json")
    ];
    const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    await expect(retryReview({ projectRoot: root, ref, maxFeedbackCycles })).rejects.toThrow(error);
    expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
  });

  it("rejects an omitted required limit from an untyped caller without writing files", async () => {
    const { root, init } = await createTestWorkspace();
    const paths = [init.workspace.manifestFile, init.workspace.stateFile];
    const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    await expect(
      Reflect.apply(retryReview, undefined, [{ projectRoot: root, ref: "T-001#R-001" }])
    ).rejects.toThrow("requires maxFeedbackCycles");
    expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
  });

  it("accepts zero and preserves passed review and unrelated Task results", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "passed", "Passed.")
    });
    const stateBefore = await readState(init.workspace.stateFile);
    const indexPath = join(init.workspace.resultsDir, "T-001", "index.json");
    const otherIndexPath = join(init.workspace.resultsDir, "T-002", "index.json");
    await writeJsonFile(otherIndexPath, { counts: { runs: 7 } });
    const indexBefore = await readFile(indexPath, "utf8");
    const otherBefore = await readFile(otherIndexPath, "utf8");
    const { manifest: before } = await loadPackage(root);
    await expect(
      retryReview({ projectRoot: root, ref: "T-001#R-001", maxFeedbackCycles: 0 })
    ).resolves.toMatchObject({ status: "completed", maxFeedbackCycles: 0, reset: false });
    expect(await readState(init.workspace.stateFile)).toEqual(stateBefore);
    expect(await readFile(indexPath, "utf8")).toBe(indexBefore);
    expect(await readFile(otherIndexPath, "utf8")).toBe(otherBefore);
    const { manifest: after } = await loadPackage(root);
    const task = before.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") throw new Error("Expected task");
    const review = task.blocks.find((block) => block.id === "R-001");
    if (review?.type !== "review") throw new Error("Expected review");
    review.review.maxFeedbackCycles = 0;
    expect(after).toEqual(before);
  });

  it.each([
    "manifest",
    "state",
    "result index"
  ])("restores manifest, state and result index after %s write failure", async (failedFile) => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "No cycles allowed.")
    });
    const paths = [
      init.workspace.manifestFile,
      init.workspace.stateFile,
      join(init.workspace.resultsDir, "T-001", "index.json")
    ];
    const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    const originalWrite = json.writeJsonFile;
    let failed = false;
    const failurePath = paths[failedFile === "manifest" ? 0 : failedFile === "state" ? 1 : 2];
    const spy = vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, value, options) => {
      if (path === failurePath && !failed) {
        failed = true;
        throw new Error("Injected retry write failure");
      }
      return originalWrite(path, value, options);
    });
    try {
      await expect(
        retryReview({ projectRoot: root, ref: "T-001#R-001", maxFeedbackCycles: 3 })
      ).rejects.toThrow("Injected retry write failure");
      expect(failed).toBe(true);
      expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports both the write failure and failed manifest restoration", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "No cycles allowed.")
    });
    const stateBefore = await readFile(init.workspace.stateFile, "utf8");
    const indexPath = join(init.workspace.resultsDir, "T-001", "index.json");
    const indexBefore = await readFile(indexPath, "utf8");
    const originalWrite = json.writeJsonFile;
    const { writeFile: originalFsWrite } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const writeError = new Error("Injected state failure");
    const restoreError = new Error("Injected manifest restore failure");
    const jsonSpy = vi
      .spyOn(json, "writeJsonFile")
      .mockImplementation(async (path, value, options) => {
        if (path === init.workspace.stateFile) throw writeError;
        return originalWrite(path, value, options);
      });
    const fsSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation((...args: Parameters<typeof fs.writeFile>) => {
        if (args[0] === init.workspace.manifestFile) return Promise.reject(restoreError);
        return Reflect.apply(originalFsWrite, fs, args);
      });
    try {
      let caught: unknown;
      try {
        await retryReview({ projectRoot: root, ref: "T-001#R-001", maxFeedbackCycles: 3 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      if (!(caught instanceof AggregateError)) throw new Error("Expected aggregate retry failure");
      expect(caught.errors).toContain(writeError);
      expect(caught.errors).toContain(restoreError);
      expect(caught.message).toContain("could not restore");
      expect(await readFile(init.workspace.stateFile, "utf8")).toBe(stateBefore);
      expect(await readFile(indexPath, "utf8")).toBe(indexBefore);
    } finally {
      jsonSpy.mockRestore();
      fsSpy.mockRestore();
    }
  });

  it("does not persist derived state before retry-review acquires the canvas lock", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "No cycles allowed.")
    });

    const expandedManifest = basicManifest({
      reviewMaxFeedbackCycles: 0,
      includeSecondTask: true
    });
    await writeJsonFile(init.workspace.manifestFile, expandedManifest);
    await writePromptFiles(init.workspace.packageDir, expandedManifest);
    expect((await readState(init.workspace.stateFile)).blocks["T-002#B-001"]).toBeUndefined();

    const lockPath = join(dirname(init.workspace.stateFile), ".planweave.lock");
    await mkdir(lockPath);
    let notifyLockAttempt!: () => void;
    const lockAttempted = new Promise<void>((resolve) => {
      notifyLockAttempt = resolve;
    });
    const { mkdir: originalMkdir } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const mkdirSpy = vi
      .spyOn(fs, "mkdir")
      .mockImplementation((...args: Parameters<typeof fs.mkdir>) => {
        if (args[0] === lockPath) notifyLockAttempt();
        return Reflect.apply(originalMkdir, fs, args);
      });
    const retry = retryReview({
      projectRoot: root,
      ref: "T-001#R-001",
      maxFeedbackCycles: 3
    });
    try {
      await lockAttempted;
      const manifestWhileLocked = await readJsonFile<PlanPackageManifest>(
        init.workspace.manifestFile
      );
      expect(manifestWhileLocked).toEqual(expandedManifest);

      const stateWhileLocked = await readState(init.workspace.stateFile);
      expect(stateWhileLocked.blocks["T-002#B-001"]).toBeUndefined();
    } finally {
      mkdirSpy.mockRestore();
      await rm(lockPath, { recursive: true, force: true });
    }

    await expect(retry).resolves.toMatchObject({
      ref: "T-001#R-001",
      status: "ready",
      maxFeedbackCycles: 3,
      reset: true
    });
    expect((await readState(init.workspace.stateFile)).blocks["T-002#B-001"]).toMatchObject({
      status: "ready"
    });
  });
});
