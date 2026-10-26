import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getExecutionStatus, runDoctor } from "../taskManager/index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { TaskResultIndex } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

describe("runDoctor", () => {
  const temporaryWorkspaces: string[] = [];
  async function createDoctorWorkspace() {
    const workspace = await createTestWorkspace();
    temporaryWorkspaces.push(workspace.root, workspace.home);
    return workspace;
  }
  afterEach(async () => {
    await Promise.all(
      temporaryWorkspaces.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
  });

  it.each([
    "preparing",
    "active",
    "completed",
    "failed"
  ] as const)("preserves a valid %s remote review during diagnosis and repair", async (phase) => {
    const { root, init } = await createDoctorWorkspace();
    const identity = {
      operationId: "operation-review",
      sourceRevision: "source-revision-001",
      graphFingerprint: "graph-fingerprint-001",
      dispatchId: "dispatch-001",
      executionAttemptId: "attempt-001"
    };
    const terminal = phase === "completed" || phase === "failed";
    const block = terminal
      ? {
          status: phase === "completed" ? "completed" : "blocked",
          ...(phase === "completed"
            ? { lastRunId: "REV-001", latestReviewAttemptId: "REV-001", completionReason: "passed" }
            : { lastRunId: "RUN-FAILED-001", blockedReason: "[executor_failed] failed" }),
          remoteOperationReceipt: {
            ...identity,
            blockType: "review",
            outcome: phase,
            ...(phase === "completed"
              ? { runId: "REV-001" }
              : { failure: { code: "executor_failed", message: "failed", retryable: true } })
          }
        }
      : {
          status: "in_progress",
          remoteOwnership:
            phase === "active"
              ? { ...identity, phase }
              : {
                  phase,
                  operationId: identity.operationId,
                  sourceRevision: identity.sourceRevision,
                  graphFingerprint: identity.graphFingerprint
                }
        };
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: terminal ? [] : ["T-001#R-001"],
      currentReviewBlockRef: terminal ? null : "T-001#R-001",
      currentFeedbackId: null,
      tasks: {},
      blocks: { "T-001#R-001": block },
      feedback: {}
    });
    if (phase === "completed") {
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
        attemptId: "REV-001"
      });
      await writeJsonFile(join(attemptDir, "review-result.json"), {
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "passed",
        content: "approved"
      });
      await writeJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"), {
        latestReviewAttemptByBlock: { "T-001#R-001": "REV-001" }
      });
    }
    const original = await readFile(init.workspace.stateFile, "utf8");
    for (const repair of [false, true, true]) {
      const report = await runDoctor({ projectRoot: root, repair });
      expect(report).toMatchObject({ ok: true, issues: [] });
      expect(report.remoteExecutions).toContainEqual(
        expect.objectContaining({ ref: "T-001#R-001" })
      );
      expect(await readFile(init.workspace.stateFile, "utf8")).toBe(original);
    }
  });

  it("reports a missing review attempt without selecting an implementation run", async () => {
    const { root, init } = await createDoctorWorkspace();
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: [],
      currentReviewBlockRef: null,
      currentFeedbackId: null,
      tasks: {},
      feedback: {},
      blocks: {
        "T-001#R-001": {
          status: "completed",
          latestReviewAttemptId: "REV-001",
          lastRunId: "REV-001",
          completionReason: "passed"
        }
      }
    });
    await writeJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"), {
      latestReviewAttemptByBlock: { "T-001#R-001": "REV-001" }
    });
    const report = await runDoctor({ projectRoot: root, repair: true });
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "review_result_missing",
        ref: "T-001#R-001",
        repaired: false
      })
    );
    expect(report.issues).not.toContainEqual(
      expect.objectContaining({ code: "index_state_mismatch" })
    );
  });

  it("reports invalid and drifted remote ownership without repairing away its evidence", async () => {
    const { root, init } = await createDoctorWorkspace();
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: ["T-404#B-001"],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#R-001": {
          status: "in_progress",
          remoteOwnership: {
            phase: "preparing",
            operationId: "operation-review",
            sourceRevision: "pgv-pkg-revision-001",
            graphFingerprint: "pkg-fingerprint-001"
          }
        },
        "T-404#B-001": {
          status: "in_progress",
          remoteOwnership: {
            phase: "preparing",
            operationId: "operation-orphan",
            sourceRevision: "pgv-pkg-revision-001",
            graphFingerprint: "pkg-fingerprint-001"
          }
        },
        "T-001#B-001": {
          status: "diverged",
          divergenceReason: "package changed",
          remoteOwnership: {
            phase: "active",
            operationId: "operation-drifted",
            sourceRevision: "pgv-pkg-revision-001",
            graphFingerprint: "pkg-fingerprint-001",
            dispatchId: "dispatch-001",
            executionAttemptId: "attempt-001"
          }
        }
      },
      feedback: {}
    });

    const report = await runDoctor({ projectRoot: root, repair: true });

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "remote_ownership_orphaned_block",
          ref: "T-404#B-001",
          repaired: false
        }),
        expect.objectContaining({
          code: "remote_ownership_source_drift",
          ref: "T-001#B-001",
          repaired: false
        }),
        expect.objectContaining({
          code: "stale_current_ref",
          ref: "T-404#B-001",
          repaired: false
        })
      ])
    );
    expect(report.issues).not.toContainEqual(expect.objectContaining({ ref: "T-001#R-001" }));
    const persisted = await readJsonFile<Record<string, unknown>>(init.workspace.stateFile);
    expect(persisted).toHaveProperty(
      "blocks.T-001#B-001.remoteOwnership.operationId",
      "operation-drifted"
    );
    expect(persisted).toHaveProperty(
      "blocks.T-404#B-001.remoteOwnership.operationId",
      "operation-orphan"
    );
    expect(persisted).toHaveProperty("currentRefs", ["T-404#B-001"]);
  });

  it("does not let index repair complete a remotely owned block", async () => {
    const { root, init } = await createDoctorWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-002");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "persisted report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-002",
      submittedAt: "2026-05-25T00:00:00.000Z"
    });
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: ["T-001#B-001"],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": {
          status: "in_progress",
          lastRunId: null,
          remoteOwnership: {
            phase: "active",
            operationId: "operation-001",
            sourceRevision: "pgv-pkg-revision-001",
            graphFingerprint: "pkg-fingerprint-001",
            dispatchId: "dispatch-001",
            executionAttemptId: "attempt-001"
          }
        }
      },
      feedback: {}
    });
    await writeJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-002" },
      counts: { runs: 2 }
    });

    const report = await runDoctor({ projectRoot: root, repair: true });

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "index_state_mismatch",
        ref: "T-001#B-001",
        repaired: false
      })
    );
    const persisted = await readJsonFile<{
      blocks: Record<string, { status: string; remoteOwnership?: { operationId: string } }>;
    }>(init.workspace.stateFile);
    expect(persisted.blocks["T-001#B-001"]).toMatchObject({
      status: "in_progress",
      remoteOwnership: { operationId: "operation-001" }
    });
  });

  it.each([
    { outcome: "completed", ref: "T-001#R-001", blockType: undefined },
    { outcome: "failed", ref: "T-001#R-001", blockType: "implementation" },
    { outcome: "completed", ref: "T-001#B-001", blockType: "review" }
  ] as const)("repairs a $outcome receipt whose type does not match $ref", async ({
    outcome,
    ref,
    blockType
  }) => {
    const { root, init } = await createDoctorWorkspace();
    const identity = {
      operationId: "operation-terminal-review",
      sourceRevision: "source-revision-001",
      graphFingerprint: "graph-fingerprint-001",
      dispatchId: "dispatch-001",
      executionAttemptId: "attempt-001"
    };
    const staleReview =
      outcome === "completed"
        ? {
            status: "completed",
            lastRunId: "RUN-REMOTE-001",
            latestReviewAttemptId: "REV-STALE",
            completionReason: "passed",
            passedWorkRevision: "work-stale",
            remoteOperationReceipt: {
              outcome,
              blockType,
              ...identity,
              runId: "RUN-REMOTE-001"
            }
          }
        : {
            status: "blocked",
            lastRunId: null,
            latestReviewAttemptId: "REV-STALE",
            blockedReason: "[executor_failed] Remote executor failed.",
            remoteOperationReceipt: {
              outcome,
              blockType,
              ...identity,
              failure: {
                code: "executor_failed",
                message: "Remote executor failed.",
                retryable: true
              }
            }
          };
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: [ref],
      currentFeedbackId: null,
      currentReviewBlockRef: ref,
      tasks: {},
      blocks: { [ref]: staleReview },
      feedback: {}
    });

    const before = await runDoctor({ projectRoot: root });
    expect(before.ok).toBe(false);
    expect(before.issues).toContainEqual(
      expect.objectContaining({
        code: "remote_terminal_type_mismatch",
        ref: ref,
        repaired: false
      })
    );
    expect(before.remoteExecutions).toContainEqual(
      expect.objectContaining({
        ref: ref,
        execution: expect.objectContaining({ phase: "terminal", status: outcome })
      })
    );

    const repair = await runDoctor({ projectRoot: root, repair: true });
    expect(repair.ok).toBe(true);
    expect(repair.issues).toContainEqual(
      expect.objectContaining({
        code: "remote_terminal_type_mismatch",
        ref: ref,
        repaired: true
      })
    );
    expect(repair.remoteExecutions).not.toContainEqual(expect.objectContaining({ ref: ref }));
    const persisted = await readJsonFile<{
      currentRefs: string[];
      currentReviewBlockRef: string | null;
      blocks: Record<string, Record<string, unknown>>;
    }>(init.workspace.stateFile);
    expect(persisted.currentRefs).toEqual([]);
    expect(persisted.currentReviewBlockRef).toBeNull();
    expect(persisted.blocks[ref]).toEqual({
      status: ref === "T-001#B-001" ? "ready" : "planned",
      lastRunId: null
    });

    const after = await runDoctor({ projectRoot: root });
    expect(after.ok).toBe(true);
    expect(after.issues).not.toContainEqual(
      expect.objectContaining({ code: "remote_terminal_type_mismatch" })
    );
    expect(after.remoteExecutions).not.toContainEqual(expect.objectContaining({ ref: ref }));
  });

  it("does not repair a non-implementation terminal receipt while active ownership blocks graph reconciliation", async () => {
    const { root, init } = await createDoctorWorkspace();
    const state = {
      currentRefs: ["T-001#R-001", "T-404#B-001"],
      currentFeedbackId: null,
      currentReviewBlockRef: "T-001#R-001",
      tasks: {},
      blocks: {
        "T-001#R-001": {
          status: "blocked",
          blockedReason: "[executor_failed] Remote executor failed.",
          remoteOperationReceipt: {
            outcome: "failed",
            operationId: "operation-terminal-review",
            sourceRevision: "source-revision-001",
            graphFingerprint: "graph-fingerprint-001",
            dispatchId: "dispatch-001",
            executionAttemptId: "attempt-001",
            failure: {
              code: "executor_failed",
              message: "Remote executor failed.",
              retryable: true
            }
          }
        },
        "T-404#B-001": {
          status: "in_progress",
          remoteOwnership: {
            phase: "preparing",
            operationId: "operation-orphan",
            sourceRevision: "source-revision-001",
            graphFingerprint: "graph-fingerprint-001"
          }
        }
      },
      feedback: {}
    };
    await writeJsonFile(init.workspace.stateFile, state);

    const report = await runDoctor({ projectRoot: root, repair: true });

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "remote_terminal_type_mismatch",
        ref: "T-001#R-001",
        repaired: false
      })
    );
    expect(report.remoteExecutions).toContainEqual(expect.objectContaining({ ref: "T-001#R-001" }));
    await expect(readJsonFile(init.workspace.stateFile)).resolves.toEqual(state);
  });

  it("keeps a failed remote terminal receipt authoritative over historical result index evidence", async () => {
    const { root, init } = await createDoctorWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-002");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "historical report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-002",
      submittedAt: "2026-05-25T00:00:00.000Z"
    });
    const failedBlock = {
      status: "blocked",
      lastRunId: null,
      blockedReason: "[executor_failed] Remote executor failed.",
      remoteOperationReceipt: {
        outcome: "failed",
        operationId: "operation-001",
        sourceRevision: "source-revision-001",
        graphFingerprint: "graph-fingerprint-001",
        dispatchId: "dispatch-001",
        executionAttemptId: "attempt-001",
        failure: {
          code: "executor_failed",
          message: "Remote executor failed.",
          retryable: true
        }
      }
    };
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: { "T-001#B-001": failedBlock },
      feedback: {}
    });
    await writeJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-002" },
      counts: { runs: 2 }
    });

    const before = await runDoctor({ projectRoot: root });
    expect(before.issues).toContainEqual(
      expect.objectContaining({
        code: "remote_terminal_result_conflict",
        ref: "T-001#B-001",
        repaired: false
      })
    );

    const repaired = await runDoctor({ projectRoot: root, repair: true });
    expect(repaired.ok).toBe(false);
    expect(repaired.issues).toContainEqual(
      expect.objectContaining({
        code: "remote_terminal_result_conflict",
        ref: "T-001#B-001",
        repaired: false
      })
    );
    const persisted = await readJsonFile<{
      blocks: Record<string, typeof failedBlock>;
    }>(init.workspace.stateFile);
    expect(persisted.blocks["T-001#B-001"]).toEqual(failedBlock);

    const after = await runDoctor({ projectRoot: root });
    expect(after.remoteExecutions).toContainEqual(
      expect.objectContaining({
        ref: "T-001#B-001",
        execution: expect.objectContaining({ status: "failed", phase: "terminal" })
      })
    );
  });

  it("reports orphan results, stale current refs, and state/index drift", async () => {
    const { root, init } = await createDoctorWorkspace();
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: ["T-404#B-001"],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": { status: "completed", lastRunId: "RUN-001" }
      },
      feedback: {}
    });
    await mkdir(join(init.workspace.resultsDir, "T-OLD"), { recursive: true });
    await writeJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-002" },
      counts: { runs: 2 }
    });

    const report = await runDoctor({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "stale_current_ref", ref: "T-404#B-001" }),
        expect.objectContaining({ code: "orphan_result", taskId: "T-OLD" }),
        expect.objectContaining({ code: "index_state_mismatch", ref: "T-001#B-001" })
      ])
    );
  });

  it("repairs stale current refs and state/index drift when requested", async () => {
    const { root, init } = await createDoctorWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-002");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "persisted report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-002",
      submittedAt: "2026-05-25T00:00:00.000Z"
    });
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: ["T-001#B-001", "T-404#B-001"],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": {
          status: "in_progress",
          lastRunId: null,
          latestReviewAttemptId: "REV-STALE",
          activeFeedbackId: "FE-ACTIVE-STALE",
          pendingFeedbackId: "FE-PENDING-STALE",
          blockedReason: "stale blocked reason",
          divergenceReason: "stale divergence reason",
          completionReason: "passed",
          passedWorkRevision: "work-stale"
        }
      },
      feedback: {}
    });
    await writeJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-002" },
      counts: { runs: 2 }
    });

    const report = await runDoctor({ projectRoot: root, repair: true });

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "stale_current_ref", ref: "T-404#B-001", repaired: true }),
        expect.objectContaining({
          code: "index_state_mismatch",
          ref: "T-001#B-001",
          repaired: true
        })
      ])
    );
    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.currentRefs).toEqual([]);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")).toMatchObject({
      status: "completed",
      lastRunId: "RUN-002",
      reason: null
    });
    const persisted = await readJsonFile<{
      blocks: Record<string, Record<string, unknown>>;
    }>(init.workspace.stateFile);
    expect(persisted.blocks["T-001#B-001"]).toEqual({
      status: "completed",
      lastRunId: "RUN-002"
    });
    await expect(
      readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).resolves.toMatchObject({
      latestRunByBlock: { "T-001#B-001": "RUN-002" },
      counts: { runs: 2 }
    });
    await expect(access(join(runDir, "report.md"))).resolves.toBeUndefined();
  });

  it("does not repair state/index drift from a run with mismatched metadata", async () => {
    const { root, init } = await createDoctorWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-002");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "persisted report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#R-001",
      taskId: "T-001",
      blockId: "R-001",
      runId: "RUN-002",
      submittedAt: "2026-05-25T00:00:00.000Z"
    });
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: ["T-001#B-001"],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": { status: "in_progress", lastRunId: null }
      },
      feedback: {}
    });
    await writeJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-002" },
      counts: { runs: 2 }
    });

    const report = await runDoctor({ projectRoot: root, repair: true });

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "index_state_mismatch",
          ref: "T-001#B-001",
          repaired: false
        })
      ])
    );
    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.currentRefs).toEqual(["T-001#B-001"]);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")).toMatchObject({
      status: "in_progress",
      lastRunId: null
    });
  });

  it("reports and repairs task index entries missing from completed state runs", async () => {
    const { root, init } = await createDoctorWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "persisted report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      submittedAt: "2026-05-25T00:00:00.000Z"
    });
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": { status: "completed", lastRunId: "RUN-001" }
      },
      feedback: {}
    });
    await writeJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"), {
      latestRunByBlock: {},
      counts: { runs: 1 }
    });

    const report = await runDoctor({ projectRoot: root, repair: true });

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "index_state_mismatch",
          ref: "T-001#B-001",
          stateRunId: "RUN-001",
          indexRunId: null,
          repaired: true
        })
      ])
    );
    await expect(
      readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).resolves.toMatchObject({
      latestRunByBlock: { "T-001#B-001": "RUN-001" },
      counts: { runs: 1 }
    });
  });
});
