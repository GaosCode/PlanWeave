import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { getExecutionStatus } from "../index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { runContractAutoRunStep } from "./autoRunTestBuilders.js";

async function expectNoActiveBlocks(root: string) {
  const status = await getExecutionStatus({ projectRoot: root });
  expect(status.blocks.some((block) => block.status === "in_progress")).toBe(false);
  expect(status.currentRefs).toEqual([]);
  return status;
}

describe("Auto Run parallel execution", () => {
  it("runs terminal executors concurrently while preserving claim order in steps", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true })
    );
    let active = 0;
    let maxActive = 0;
    let signalOverlap = () => undefined;
    let releaseExecutors = () => undefined;
    const overlap = new Promise<void>((resolve) => {
      signalOverlap = resolve;
    });
    const executorGate = new Promise<void>((resolve) => {
      releaseExecutors = resolve;
    });
    const finishedRefs: string[] = [];
    const stepPromise = runContractAutoRunStep({
      projectRoot: root,
      parallel: true,
      executor: {
        async runBlock({ claim }) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (active === 2) {
            signalOverlap();
          }
          await executorGate;
          if (claim.ref === "T-001#B-001") {
            await delay(20);
          }
          const reportPath = join(root, `${claim.taskId}-${claim.blockId}.md`);
          await writeFile(reportPath, `${claim.ref} completed\n`, "utf8");
          finishedRefs.push(claim.ref);
          active -= 1;
          return { kind: "block", reportPath };
        },
        async runFeedback() {
          throw new Error("feedback should not run in a parallel batch");
        }
      }
    });
    const overlapped = await Promise.race([
      overlap.then(() => true),
      delay(2_000).then(() => false)
    ]);
    releaseExecutors();
    const step = await stepPromise;

    expect(overlapped).toBe(true);
    expect(maxActive).toBe(2);
    expect(finishedRefs).toEqual(["T-002#B-001", "T-001#B-001"]);
    expect(step).toMatchObject({
      kind: "batch_submitted",
      claim: { kind: "batch", refs: ["T-001#B-001", "T-002#B-001"] },
      steps: [
        { kind: "submitted", submitResult: { ref: "T-001#B-001", status: "completed" } },
        { kind: "submitted", submitResult: { ref: "T-002#B-001", status: "completed" } }
      ]
    });
    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("completed");
    expect(status.blocks.find((block) => block.ref === "T-002#B-001")?.status).toBe("completed");
  });

  it("releases a manual sibling after failure so a follow-up step can execute it", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true })
    );
    let firstAttempt = true;
    const executor = {
      async runBlock({ claim }) {
        if (firstAttempt && claim.ref === "T-001#B-001") {
          throw new Error(`simulated failure for ${claim.ref}`);
        }
        if (firstAttempt) {
          return {
            kind: "manual" as const,
            promptPath: join(root, "manual-prompt.md"),
            runDir: root,
            runId: "RUN-MANUAL",
            executor: "manual",
            adapter: "manual" as const,
            nextCommand: "submit the manual report"
          };
        }
        const reportPath = join(root, `${claim.taskId}-${claim.blockId}.md`);
        await writeFile(reportPath, `${claim.ref} completed\n`, "utf8");
        return { kind: "block" as const, reportPath };
      },
      async runFeedback() {
        throw new Error("feedback should not run in a parallel batch");
      }
    };

    const failed = await runContractAutoRunStep({ projectRoot: root, parallel: true, executor });
    expect(failed).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("Executor failed for T-001#B-001")
      }
    });

    const afterFailure = await expectNoActiveBlocks(root);
    expect(afterFailure.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe(
      "blocked"
    );
    expect(afterFailure.blocks.find((block) => block.ref === "T-002#B-001")?.status).toBe("ready");

    firstAttempt = false;
    const recovered = await runContractAutoRunStep({ projectRoot: root, parallel: true, executor });
    expect(recovered).toMatchObject({
      kind: "batch_submitted",
      claim: { kind: "batch", refs: ["T-002#B-001"] },
      steps: [
        {
          kind: "submitted",
          submitResult: { ref: "T-002#B-001", status: "completed" }
        }
      ]
    });
    const afterRecovery = await getExecutionStatus({ projectRoot: root });
    expect(afterRecovery.blocks.find((block) => block.ref === "T-002#B-001")?.status).toBe(
      "completed"
    );
  });

  it("waits for and blocks every failed ref before choosing the first failure", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true })
    );
    const failed = await runContractAutoRunStep({
      projectRoot: root,
      parallel: true,
      executor: {
        async runBlock({ claim }) {
          throw new Error(`failure for ${claim.ref}`);
        },
        async runFeedback() {
          throw new Error("feedback should not run in a parallel batch");
        }
      }
    });

    expect(failed).toMatchObject({
      kind: "blocked",
      claim: { kind: "blocked", ref: "T-001#B-001" }
    });
    const status = await expectNoActiveBlocks(root);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("blocked");
    expect(status.blocks.find((block) => block.ref === "T-002#B-001")?.status).toBe("blocked");
  });

  it("waits for a successful sibling when another batch submission fails", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true })
    );
    let successfulSiblingFinished = false;
    const failed = await runContractAutoRunStep({
      projectRoot: root,
      parallel: true,
      executor: {
        async runBlock({ claim }) {
          if (claim.ref === "T-001#B-001") {
            return { kind: "block" as const, reportPath: join(root, "missing-report.md") };
          }
          await delay(20);
          const reportPath = join(root, "successful-sibling.md");
          await writeFile(reportPath, "sibling completed\n", "utf8");
          successfulSiblingFinished = true;
          return { kind: "block" as const, reportPath };
        },
        async runFeedback() {
          throw new Error("feedback should not run in a parallel batch");
        }
      }
    });

    expect(successfulSiblingFinished).toBe(true);
    expect(failed).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("Implementation submission failed for T-001#B-001")
      }
    });
    const status = await expectNoActiveBlocks(root);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("blocked");
    expect(status.blocks.find((block) => block.ref === "T-002#B-001")?.status).toBe("completed");
  });

  it("blocks a sequential implementation when prompt rendering fails", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"));
    let executorCalled = false;

    const failed = await runContractAutoRunStep({
      projectRoot: root,
      executor: {
        async runBlock() {
          executorCalled = true;
          throw new Error("executor should not run");
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      }
    });

    expect(executorCalled).toBe(false);
    expect(failed).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("Prompt rendering failed for T-001#B-001")
      }
    });
    await expectNoActiveBlocks(root);
  });

  it("blocks a sequential implementation when the adapter returns the wrong result kind", async () => {
    const { root } = await createTestWorkspace();
    const failed = await runContractAutoRunStep({
      projectRoot: root,
      executor: {
        async runBlock() {
          return { kind: "feedback" as const, reportPath: join(root, "unexpected-feedback.md") };
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      }
    });

    expect(failed).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("Executor result validation failed for T-001#B-001")
      }
    });
    await expectNoActiveBlocks(root);
  });

  it("blocks a sequential implementation when report submission fails", async () => {
    const { root } = await createTestWorkspace();
    const failed = await runContractAutoRunStep({
      projectRoot: root,
      executor: {
        async runBlock() {
          return { kind: "block" as const, reportPath: join(root, "missing-report.md") };
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      }
    });

    expect(failed).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("Implementation submission failed for T-001#B-001")
      }
    });
    await expectNoActiveBlocks(root);
  });

  it("surfaces cleanup failure instead of returning a false blocked result", async () => {
    const { root, init } = await createTestWorkspace();

    await expect(
      runContractAutoRunStep({
        projectRoot: root,
        executor: {
          async runBlock() {
            await writeFile(init.workspace.stateFile, "{ invalid state", "utf8");
            throw new Error("executor failed before cleanup");
          },
          async runFeedback() {
            throw new Error("feedback should not run");
          }
        }
      })
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: expect.stringContaining("failed to mark the block blocked")
    });
  });

  it("blocks a sequential review when review-result submission fails", async () => {
    const { root } = await createTestWorkspace();
    const executor = {
      async runBlock({ claim }) {
        if (claim.blockType === "review") {
          return { kind: "review" as const, resultPath: join(root, "missing-review-result.json") };
        }
        const reportPath = join(root, "implementation-report.md");
        await writeFile(reportPath, "implementation complete\n", "utf8");
        return { kind: "block" as const, reportPath };
      },
      async runFeedback() {
        throw new Error("feedback should not run");
      }
    };

    await expect(runContractAutoRunStep({ projectRoot: root, executor })).resolves.toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" }
    });
    const failed = await runContractAutoRunStep({ projectRoot: root, executor });

    expect(failed).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#R-001",
        reason: expect.stringContaining("Review submission failed for T-001#R-001")
      }
    });
    const status = await expectNoActiveBlocks(root);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("completed");
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")?.status).toBe("blocked");
  });

  it("falls back to sequential claims for reviews when parallel batches are exhausted", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true })
    );
    const executor = {
      async runBlock({ claim }) {
        if (claim.blockType === "review") {
          const resultPath = join(root, `${claim.taskId}-${claim.blockId}.json`);
          await writeFile(
            resultPath,
            JSON.stringify({
              reviewBlockRef: claim.ref,
              taskId: claim.taskId,
              verdict: "passed",
              content: "ok"
            }),
            "utf8"
          );
          return { kind: "review" as const, resultPath };
        }
        const reportPath = join(root, `${claim.taskId}-${claim.blockId}.md`);
        await writeFile(reportPath, `${claim.ref} completed\n`, "utf8");
        return { kind: "block" as const, reportPath };
      },
      async runFeedback() {
        throw new Error("feedback should not run");
      }
    };

    await expect(
      runContractAutoRunStep({ projectRoot: root, parallel: true, executor })
    ).resolves.toMatchObject({
      kind: "batch_submitted",
      claim: { refs: ["T-001#B-001", "T-002#B-001"] }
    });
    await expect(
      runContractAutoRunStep({ projectRoot: root, parallel: true, executor })
    ).resolves.toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      submitResult: { verdict: "passed", status: "completed" }
    });
  });
});
