import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createContractLocalReviewAdapter, runContractAutoRunStep } from "./autoRunTestBuilders.js";

describe("Auto Run local review executor", () => {
  it("local-review adapter submits review JSON without creating an agent session", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-local-review", {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          [
            "const result = {",
            "  reviewBlockRef: process.env.PLANWEAVE_REVIEW_BLOCK_REF,",
            "  taskId: process.env.PLANWEAVE_TASK_ID,",
            "  verdict: process.env.PLANWEAVE_BLOCK_ID === 'R-001' ? 'passed' : 'needs_changes',",
            "  content: 'passed by local review'",
            "};",
            "console.log(JSON.stringify(result));"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-local-review")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    await runContractAutoRunStep({
      projectRoot: root,
      executor: {
        async runBlock() {
          const reportPath = join(root, "implementation.md");
          await writeFile(reportPath, "implemented\n", "utf8");
          return { kind: "block", reportPath };
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      }
    });
    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractLocalReviewAdapter({
        projectRoot: root,
        executorName: "fake-local-review"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      adapterResult: { kind: "review", adapter: "local-review", agentSessionId: null },
      submitResult: { ref: "T-001#R-001", verdict: "passed", status: "completed" }
    });
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "R-001", "runs", "RUN-001", "metadata.json"))).resolves.toMatchObject({
      executor: "fake-local-review",
      adapter: "local-review",
      agentSessionId: null,
      codexSessionId: null,
      exitCode: 0
    });
  });
});
