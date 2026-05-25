import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../taskManager/index.js";
import { writeJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

describe("runDoctor", () => {
  it("reports orphan results, stale current refs, and state/index drift", async () => {
    const { root, init } = await createTestWorkspace();
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
});
