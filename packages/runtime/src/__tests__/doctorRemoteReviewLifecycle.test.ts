import { readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFile } from "../json.js";
import { readState, writeState } from "../state.js";
import { runDoctor } from "../taskManager/doctor.js";
import { createRemoteBlockRuntimePort } from "../taskManager/index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { claimIdentity, remoteManifest, reportInput } from "./remoteBlockTestHelpers.js";

const reviewRef = "T-001#R-001";
const implementationRef = "T-001#B-001";

async function resultContents(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const children = await resultContents(path);
      for (const [name, bytes] of Object.entries(children)) {
        files[join(entry.name, name)] = bytes;
      }
    } else {
      files[entry.name] = (await readFile(path)).toString("base64");
    }
  }
  return files;
}

describe("Doctor after real remote review lifecycle writes", () => {
  const temporaryWorkspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryWorkspaces.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
  });

  async function completeImplementation() {
    const manifest = remoteManifest();
    const workspace = await createTestWorkspace(manifest);
    temporaryWorkspaces.push(workspace.root, workspace.home);
    const port = createRemoteBlockRuntimePort({ projectRoot: workspace.root });
    const implementation = await port.inspect({ ref: implementationRef });
    const implementationIdentity = {
      operationId: "operation-implementation",
      controlPlane: "collaboration" as const,
      sourceRevision: implementation.sourceRevision,
      graphFingerprint: implementation.graphFingerprint,
      dispatchId: "dispatch-implementation",
      executionAttemptId: "attempt-implementation"
    };
    await port.claim({ ref: implementationRef, ...claimIdentity(implementationIdentity) });
    await port.activate({ ref: implementationRef, ...implementationIdentity });
    await port.complete({
      ref: implementationRef,
      ...implementationIdentity,
      ...reportInput(Buffer.from("# Implementation evidence\n"))
    });
    return { ...workspace, manifest, port };
  }

  async function prepareReview() {
    const workspace = await completeImplementation();
    const { port } = workspace;
    const candidate = await port.inspect({ ref: reviewRef });
    const identity = {
      operationId: "operation-review",
      controlPlane: "collaboration" as const,
      sourceRevision: candidate.sourceRevision,
      graphFingerprint: candidate.graphFingerprint,
      dispatchId: "dispatch-review",
      executionAttemptId: "attempt-review"
    };
    await port.claim({ ref: reviewRef, ...claimIdentity(identity) });
    return { ...workspace, identity };
  }

  async function completeReview(verdict: "passed" | "needs_changes" = "passed") {
    const workspace = await prepareReview();
    await workspace.port.activate({ ref: reviewRef, ...workspace.identity });
    const completed = await workspace.port.complete({
      ref: reviewRef,
      ...workspace.identity,
      ...reportInput(
        Buffer.from(
          JSON.stringify({
            reviewBlockRef: reviewRef,
            taskId: "T-001",
            verdict,
            content: verdict === "passed" ? "Evidence accepted." : "Update the evidence."
          })
        )
      )
    });
    return { ...workspace, completed };
  }

  async function expectDoctorPreserves(
    workspace: Awaited<ReturnType<typeof completeImplementation>>,
    issueCodes: string[] = []
  ) {
    const { stateFile, resultsDir } = workspace.init.workspace;
    const stateBefore = await readFile(stateFile, "utf8");
    const resultsBefore = await resultContents(resultsDir);
    for (const repair of [false, true, false, true]) {
      const report = await runDoctor({ projectRoot: workspace.root, repair });
      expect(await readFile(stateFile, "utf8")).toBe(stateBefore);
      expect(await resultContents(resultsDir)).toEqual(resultsBefore);
      expect(report.issues.map((issue) => issue.code).sort()).toEqual([...issueCodes].sort());
      expect(report.ok).toBe(issueCodes.length === 0);
      expect(report.issues.every((issue) => issue.repaired === false)).toBe(true);
    }
  }

  it.each([
    "preparing",
    "active"
  ] as const)("preserves a real %s owner and current Review pointers", async (phase) => {
    const workspace = await prepareReview();
    if (phase === "active") {
      await workspace.port.activate({ ref: reviewRef, ...workspace.identity });
    }
    const state = await readState(workspace.init.workspace.stateFile);
    expect(state.blocks[reviewRef]).toMatchObject({
      status: "in_progress",
      remoteOwnership: { phase, operationId: workspace.identity.operationId }
    });
    expect(state.currentReviewBlockRef).toBe(reviewRef);
    expect(state.currentRefs).toContain(reviewRef);
    await expectDoctorPreserves(workspace);
  });

  it.each([
    "passed",
    "needs_changes"
  ] as const)("preserves real %s attempt artifacts, receipts and feedback pointers", async (verdict) => {
    const workspace = await completeReview(verdict);
    const state = await readState(workspace.init.workspace.stateFile);
    const block = state.blocks[reviewRef];
    expect(workspace.completed.runId).toMatch(/^REV-\d+$/);
    expect(block.latestReviewAttemptId).toBe(workspace.completed.runId);
    const attemptDir = join(
      workspace.init.workspace.resultsDir,
      "T-001/reviews/R-001/attempts",
      workspace.completed.runId
    );
    expect(await readJsonFile(join(attemptDir, "review-result.json"))).toMatchObject({
      reviewBlockRef: reviewRef,
      taskId: "T-001",
      verdict
    });
    expect(await readJsonFile(join(attemptDir, "metadata.json"))).toMatchObject({
      reviewBlockRef: reviewRef,
      attemptId: workspace.completed.runId
    });
    expect(block.remoteOwnership).toBeUndefined();
    if (verdict === "passed") {
      expect(block).toMatchObject({
        status: "completed",
        lastRunId: workspace.completed.runId,
        remoteOperationReceipt: { outcome: "completed", blockType: "review" }
      });
      expect(state.currentReviewBlockRef).toBeNull();
    } else {
      expect(block.status).toBe("in_progress");
      expect(block.remoteOperationReceipt).toBeUndefined();
      expect(state.currentReviewBlockRef).toBe(reviewRef);
      expect(state.currentFeedbackId).toBe(block.activeFeedbackId);
      expect(state.feedback[block.activeFeedbackId!]).toMatchObject({
        sourceReviewBlockRef: reviewRef,
        status: "open"
      });
    }
    await expectDoctorPreserves(workspace);
  });

  it.each([
    "failed",
    "interrupted"
  ] as const)("preserves real %s state and its execution evidence", async (outcome) => {
    const workspace = await prepareReview();
    await workspace.port.activate({ ref: reviewRef, ...workspace.identity });
    if (outcome === "failed") {
      await workspace.port.fail({
        ref: reviewRef,
        ...workspace.identity,
        failure: { code: "executor_failed", message: "Remote executor failed.", retryable: true }
      });
    } else {
      await workspace.port.markInterrupted({
        ref: reviewRef,
        ...workspace.identity,
        interruption: { reason: "transport_lost", resumable: true }
      });
    }
    const state = await readState(workspace.init.workspace.stateFile);
    expect(state.currentReviewBlockRef).toBeNull();
    expect(state.currentRefs).not.toContain(reviewRef);
    if (outcome === "failed") {
      expect(state.blocks[reviewRef]).toMatchObject({
        status: "blocked",
        lastRunId: expect.stringMatching(/^RUN-\d+$/),
        remoteOperationReceipt: { outcome: "failed", blockType: "review" }
      });
      expect(state.blocks[reviewRef].latestReviewAttemptId).toBeUndefined();
    } else {
      expect(state.blocks[reviewRef]).toMatchObject({
        status: "diverged",
        remoteOwnership: { operationId: workspace.identity.operationId },
        remoteInterruption: { reason: "transport_lost", resumable: true }
      });
    }
    await expectDoctorPreserves(
      workspace,
      outcome === "interrupted" ? ["remote_ownership_interrupted"] : []
    );
  });

  it("preserves a legacy implementation receipt produced before blockType was recorded", async () => {
    const workspace = await completeImplementation();
    const state = await readState(workspace.init.workspace.stateFile);
    const receipt = state.blocks[implementationRef].remoteOperationReceipt;
    expect(receipt).toMatchObject({ outcome: "completed", blockType: "implementation" });
    delete receipt!.blockType;
    await writeState(workspace.init.workspace.stateFile, state);
    await expectDoctorPreserves(workspace);
  });

  it.each([
    "metadata.json",
    "review-result.json"
  ])("reports missing real attempt %s without changing pointers or history", async (missingFile) => {
    const workspace = await completeReview();
    const artifactPath = join(
      workspace.init.workspace.resultsDir,
      "T-001/reviews/R-001/attempts",
      workspace.completed.runId,
      missingFile
    );
    await rename(artifactPath, `${artifactPath}.unavailable`);
    await expectDoctorPreserves(workspace, ["review_result_missing"]);
    await rename(`${artifactPath}.unavailable`, artifactPath);
    await expectDoctorPreserves(workspace);
  });

  it.each([
    "implementation",
    "legacy"
  ] as const)("repairs a %s receipt on a Review without deleting its genuine attempts", async (receiptType) => {
    const workspace = await completeReview();
    const stateFile = workspace.init.workspace.stateFile;
    const state = await readState(stateFile);
    const receipt = state.blocks[reviewRef].remoteOperationReceipt!;
    if (receiptType === "legacy") {
      delete receipt.blockType;
    } else {
      receipt.blockType = receiptType;
    }
    await writeState(stateFile, state);
    const beforeResults = await resultContents(workspace.init.workspace.resultsDir);
    expect((await runDoctor({ projectRoot: workspace.root })).issues).toContainEqual(
      expect.objectContaining({
        code: "remote_terminal_type_mismatch",
        ref: reviewRef,
        repaired: false
      })
    );
    const repaired = await runDoctor({ projectRoot: workspace.root, repair: true });
    expect(repaired.issues).toContainEqual(
      expect.objectContaining({
        code: "remote_terminal_type_mismatch",
        ref: reviewRef,
        repaired: true
      })
    );
    expect((await readState(stateFile)).blocks[reviewRef].remoteOperationReceipt).toBeUndefined();
    expect(await resultContents(workspace.init.workspace.resultsDir)).toEqual(beforeResults);
    await expectDoctorPreserves(workspace, ["review_index_state_mismatch"]);
  });

  it("diagnoses a manifest type change while preserving historical Review files", async () => {
    const workspace = await completeReview();
    const task = workspace.manifest.nodes[0];
    if (task.type !== "task") throw new Error("Expected task fixture.");
    task.blocks = task.blocks.map((block) =>
      block.id === "R-001"
        ? {
            id: block.id,
            type: "implementation",
            title: block.title,
            prompt: block.prompt,
            depends_on: block.depends_on
          }
        : block
    );
    await writeJsonFile(workspace.init.workspace.manifestFile, workspace.manifest);
    const beforeResults = await resultContents(workspace.init.workspace.resultsDir);
    expect((await runDoctor({ projectRoot: workspace.root })).issues).toContainEqual(
      expect.objectContaining({ code: "remote_terminal_type_mismatch", repaired: false })
    );
    const repaired = await runDoctor({ projectRoot: workspace.root, repair: true });
    expect(repaired.issues).toContainEqual(
      expect.objectContaining({ code: "remote_terminal_type_mismatch", repaired: true })
    );
    expect((await readState(workspace.init.workspace.stateFile)).blocks[reviewRef]).toEqual({
      status: "ready",
      lastRunId: null
    });
    expect(await resultContents(workspace.init.workspace.resultsDir)).toEqual(beforeResults);
    await expectDoctorPreserves(workspace, [
      "result_index_block_type_mismatch",
      "index_state_mismatch"
    ]);
  });

  it("reports an unknown Review block without discarding its receipt or results", async () => {
    const workspace = await completeReview();
    const task = workspace.manifest.nodes[0];
    if (task.type !== "task") throw new Error("Expected task fixture.");
    task.blocks = task.blocks.filter((block) => block.id !== "R-001");
    await writeJsonFile(workspace.init.workspace.manifestFile, workspace.manifest);
    await expectDoctorPreserves(workspace, [
      "remote_terminal_orphaned_block",
      "result_index_block_type_mismatch",
      "result_index_block_type_mismatch"
    ]);
  });

  it.each([
    "remote_terminal_type_mismatch",
    "stale_current_ref",
    "index_state_mismatch"
  ] as const)("preserves an orphan Review receipt alongside %s during repeated repair", async (issueCode) => {
    const workspace = await completeReview();
    const task = workspace.manifest.nodes[0];
    if (task.type !== "task") throw new Error("Expected task fixture.");
    task.blocks = task.blocks.filter((block) => block.id !== "R-001");
    await writeJsonFile(workspace.init.workspace.manifestFile, workspace.manifest);

    const state = await readState(workspace.init.workspace.stateFile);
    expect(state.blocks[reviewRef].remoteOperationReceipt).toMatchObject({
      ...workspace.identity,
      blockType: "review",
      outcome: "completed",
      runId: workspace.completed.runId
    });
    if (issueCode === "remote_terminal_type_mismatch") {
      state.blocks[implementationRef].remoteOperationReceipt!.blockType = "review";
    } else if (issueCode === "stale_current_ref") {
      state.currentRefs = ["T-001#B-999"];
    } else {
      delete state.blocks[implementationRef].remoteOperationReceipt;
      state.blocks[implementationRef].status = "ready";
      state.blocks[implementationRef].lastRunId = null;
    }
    await writeState(workspace.init.workspace.stateFile, state);

    await expectDoctorPreserves(workspace, [
      "remote_terminal_orphaned_block",
      "result_index_block_type_mismatch",
      "result_index_block_type_mismatch",
      issueCode
    ]);
  });
});
