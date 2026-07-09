import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getExecutionStatus } from "../index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { runContractAutoRunStep } from "./autoRunTestBuilders.js";

describe("Auto Run parallel execution", () => {
  it("dispatches and submits every block in a parallel batch", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true })
    );
    const step = await runContractAutoRunStep({
      projectRoot: root,
      parallel: true,
      executor: {
        async runBlock({ claim }) {
          const reportPath = join(root, `${claim.taskId}-${claim.blockId}.md`);
          await writeFile(reportPath, `${claim.ref} completed\n`, "utf8");
          return { kind: "block", reportPath };
        },
        async runFeedback() {
          throw new Error("feedback should not run in a parallel batch");
        }
      }
    });

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

  it("releases unstarted siblings when a parallel batch block fails", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true })
    );
    let firstRef: string | null = null;
    const executor = {
      async runBlock({ claim }) {
        if (firstRef === null) {
          firstRef = claim.ref;
          throw new Error(`simulated failure for ${claim.ref}`);
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
    expect(failed.kind).toBe("blocked");
    expect(firstRef).toBeTruthy();
    const siblingRef = firstRef === "T-001#B-001" ? "T-002#B-001" : "T-001#B-001";

    const afterFailure = await getExecutionStatus({ projectRoot: root });
    expect(afterFailure.blocks.find((block) => block.ref === firstRef)?.status).toBe("blocked");
    expect(afterFailure.blocks.find((block) => block.ref === siblingRef)?.status).toBe("ready");
    expect(afterFailure.blocks.some((block) => block.status === "in_progress")).toBe(false);
    expect(afterFailure.currentRefs).toEqual([]);

    const recovered = await runContractAutoRunStep({ projectRoot: root, parallel: true, executor });
    expect(recovered).toMatchObject({
      kind: "batch_submitted",
      claim: { kind: "batch", refs: [siblingRef] },
      steps: [{ kind: "submitted", submitResult: { ref: siblingRef, status: "completed" } }]
    });
    const afterRecovery = await getExecutionStatus({ projectRoot: root });
    expect(afterRecovery.blocks.find((block) => block.ref === siblingRef)?.status).toBe(
      "completed"
    );
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
