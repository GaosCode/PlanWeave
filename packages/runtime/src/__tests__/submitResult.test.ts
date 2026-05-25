import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFile } from "../json.js";
import { claimNext, getExecutionStatus, submitBlockResult } from "../taskManager/index.js";
import type { TaskResultIndex } from "../types.js";
import { createTestWorkspace, writeReport } from "./promptTestHelpers.js";

describe("submitBlockResult", () => {
  it("stores implementation reports under the block run history", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });

    const result = await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "report.md") });

    expect(result).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    await expect(access(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "report.md"))).resolves.toBeUndefined();
  });

  it("does not accept review blocks", async () => {
    const { root } = await createTestWorkspace();

    await expect(
      submitBlockResult({ projectRoot: root, ref: "T-001#R-001", reportPath: await writeReport(root, "review.md") })
    ).rejects.toThrow("submit-result only accepts implementation/check blocks");
  });

  it("recovers an already persisted run when state was not updated", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const runDir = join(runRoot, "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "persisted report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      submittedAt: "2026-05-25T00:00:00.000Z",
      sourceReportPath: "/tmp/original-report.md"
    });
    await writeJsonFile(join(init.workspace.resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-001" },
      counts: { runs: 1 }
    });

    const result = await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "retry.md") });

    expect(result).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    await expect(access(join(runRoot, "RUN-002"))).rejects.toThrow();
    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")).toMatchObject({
      status: "completed",
      lastRunId: "RUN-001"
    });
    expect(status.currentRefs).toEqual([]);
    await expect(readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))).resolves.toMatchObject({
      latestRunByBlock: { "T-001#B-001": "RUN-001" },
      counts: { runs: 1 }
    });
  });

  it("returns the same run id when the same report is submitted again", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const reportPath = await writeReport(root, "same-report.md", "same report\n");

    const first = await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath });
    const second = await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath });

    expect(first).toEqual({ ref: "T-001#B-001", runId: "RUN-001", status: "completed" });
    expect(second).toEqual(first);
  });
});
