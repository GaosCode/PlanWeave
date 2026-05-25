import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getExecutionStatus, runDoctor } from "../taskManager/index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { TaskResultIndex } from "../types.js";
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

  it("repairs stale current refs and state/index drift when requested", async () => {
    const { root, init } = await createTestWorkspace();
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
        "T-001#B-001": { status: "in_progress", lastRunId: null }
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
        expect.objectContaining({ code: "index_state_mismatch", ref: "T-001#B-001", repaired: true })
      ])
    );
    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.currentRefs).toEqual([]);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")).toMatchObject({
      status: "completed",
      lastRunId: "RUN-002"
    });
    await expect(readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))).resolves.toMatchObject({
      latestRunByBlock: { "T-001#B-001": "RUN-002" },
      counts: { runs: 2 }
    });
    await expect(access(join(runDir, "report.md"))).resolves.toBeUndefined();
  });

  it("does not repair state/index drift from a run with mismatched metadata", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-002");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "persisted report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#C-001",
      taskId: "T-001",
      blockId: "C-001",
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
        expect.objectContaining({ code: "index_state_mismatch", ref: "T-001#B-001", repaired: false })
      ])
    );
    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.currentRefs).toEqual(["T-001#B-001"]);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")).toMatchObject({
      status: "in_progress",
      lastRunId: null
    });
  });
});
