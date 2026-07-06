import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getExecutionStatus } from "../index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { runContractAutoRunStep } from "./autoRunTestBuilders.js";

describe("Auto Run parallel execution", () => {
  it("dispatches and submits every block in a parallel batch", async () => {
    const { root } = await createTestWorkspace(basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true }));
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

  it("falls back to sequential claims for reviews when parallel batches are exhausted", async () => {
    const { root } = await createTestWorkspace(basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true }));
    const executor = {
      async runBlock({ claim }) {
        if (claim.blockType === "review") {
          const resultPath = join(root, `${claim.taskId}-${claim.blockId}.json`);
          await writeFile(resultPath, JSON.stringify({ reviewBlockRef: claim.ref, taskId: claim.taskId, verdict: "passed", content: "ok" }), "utf8");
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

    await expect(runContractAutoRunStep({ projectRoot: root, parallel: true, executor })).resolves.toMatchObject({
      kind: "batch_submitted",
      claim: { refs: ["T-001#B-001", "T-002#B-001"] }
    });
    await expect(runContractAutoRunStep({ projectRoot: root, parallel: true, executor })).resolves.toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      submitResult: { verdict: "passed", status: "completed" }
    });
  });
});
