import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonFile } from "../json.js";
import { runDoctor } from "../taskManager/index.js";
import {
  clearReviewCompletionReason,
  incrementTaskIndexCount,
  parseTaskResultIndex,
  readTaskIndex,
  recordReviewCompletionReason,
  updateTaskIndex
} from "../taskManager/resultIndex.js";
import type { TaskResultIndex } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function validIndex(overrides: TaskResultIndex = {}): TaskResultIndex {
  return {
    latestRunByBlock: { "T-001#B-001": "RUN-001" },
    latestReviewAttemptByBlock: { "T-001#R-001": "REV-001" },
    latestReviewVerdictByBlock: { "T-001#R-001": "passed" },
    latestReviewedWorkRevisionByBlock: { "T-001#R-001": "rev-abc" },
    latestFeedbackByReviewBlock: { "T-001#R-001": "FE-001" },
    latestFeedbackSubmissionByFeedback: { "FE-001": "FS-001" },
    feedbackStatusById: { "FE-001": "resolved" },
    reviewCompletionReasonByBlock: { "T-001#R-001": "passed" },
    counts: {
      runs: 1,
      reviewAttempts: 1,
      feedbackEnvelopes: 1,
      feedbackSubmissions: 1
    },
    warnings: [
      {
        code: "review_max_cycles_reached",
        message: "max cycles",
        path: "T-001#R-001"
      }
    ],
    ...overrides
  };
}

describe("parseTaskResultIndex", () => {
  it("accepts empty and full current indexes", () => {
    expect(parseTaskResultIndex({}, "/tmp/index.json")).toEqual({});
    const full = validIndex();
    expect(parseTaskResultIndex(full, "/tmp/index.json")).toEqual(full);
  });

  it("rejects invalid, negative, and non-integer counts", () => {
    expect(() => parseTaskResultIndex({ counts: { runs: -1 } }, "/tmp/index.json")).toThrow(
      /Task result index at \/tmp\/index\.json is invalid:.*counts\.runs/
    );
    expect(() => parseTaskResultIndex({ counts: { runs: 1.5 } }, "/tmp/index.json")).toThrow(
      /Task result index at \/tmp\/index\.json is invalid:.*counts\.runs/
    );
    expect(() =>
      parseTaskResultIndex({ counts: { reviewAttempts: "1" } }, "/tmp/index.json")
    ).toThrow(/Task result index at \/tmp\/index\.json is invalid:.*counts\.reviewAttempts/);
  });

  it("rejects invalid completion reason, feedback status, verdict, maps, and unknown fields", () => {
    expect(() =>
      parseTaskResultIndex(
        { reviewCompletionReasonByBlock: { "T-001#R-001": "timeout" } },
        "/tmp/index.json"
      )
    ).toThrow(/reviewCompletionReasonByBlock/);
    expect(() =>
      parseTaskResultIndex({ feedbackStatusById: { "FE-001": "pending" } }, "/tmp/index.json")
    ).toThrow(/feedbackStatusById/);
    expect(() =>
      parseTaskResultIndex(
        { latestReviewVerdictByBlock: { "T-001#R-001": "approved" } },
        "/tmp/index.json"
      )
    ).toThrow(/latestReviewVerdictByBlock/);
    expect(() =>
      parseTaskResultIndex({ latestRunByBlock: { "T-001#B-001": 12 } }, "/tmp/index.json")
    ).toThrow(/latestRunByBlock/);
    expect(() => parseTaskResultIndex({ warnings: [{ code: "x" }] }, "/tmp/index.json")).toThrow(
      /warnings/
    );
    expect(() =>
      parseTaskResultIndex({ ...validIndex(), unexpected: true }, "/tmp/index.json")
    ).toThrow(/Task result index at \/tmp\/index\.json is invalid/);
    expect(() =>
      parseTaskResultIndex({ counts: { runs: 1, extra: 2 } }, "/tmp/index.json")
    ).toThrow(/counts/);
  });
});

describe("readTaskIndex", () => {
  it("returns {} only when index.json is missing", async () => {
    const { init } = await createTestWorkspace();
    await expect(readTaskIndex(init.workspace, "T-001")).resolves.toEqual({});
  });

  it("reads a valid index and rejects malformed JSON and invalid schema content", async () => {
    const { init } = await createTestWorkspace();
    const indexPath = join(init.workspace.resultsDir, "T-001", "index.json");
    const valid = validIndex({
      counts: { runs: 2 },
      warnings: undefined
    });
    await mkdir(join(init.workspace.resultsDir, "T-001"), { recursive: true });
    await writeJsonFile(indexPath, valid);
    await expect(readTaskIndex(init.workspace, "T-001")).resolves.toEqual(valid);

    await writeFile(indexPath, "{", "utf8");
    await expect(readTaskIndex(init.workspace, "T-001")).rejects.toThrow(
      `Task result index at ${indexPath} is malformed JSON`
    );

    await writeJsonFile(indexPath, { counts: { runs: -3 } });
    await expect(readTaskIndex(init.workspace, "T-001")).rejects.toThrow(
      `Task result index at ${indexPath} is invalid`
    );
  });

  it("surfaces non-missing I/O failures without masking them as empty indexes", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "planweave-task-index-io-"));
    const blockedDir = join(dir, "blocked");
    const resultsDir = join(blockedDir, "results");
    const taskDir = join(resultsDir, "T-001");
    await mkdir(taskDir, { recursive: true });
    await writeJsonFile(join(taskDir, "index.json"), { counts: { runs: 1 } });
    await chmod(taskDir, 0o000);
    try {
      await expect(
        readTaskIndex(
          {
            resultsDir,
            stateFile: join(blockedDir, "state.json")
          } as never,
          "T-001"
        )
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(taskDir, 0o755);
    }
  });
});

describe("task result index merge and locking behavior", () => {
  it("increments counts, preserves warnings, and removes completion reasons cleanly", async () => {
    const { init } = await createTestWorkspace();
    await updateTaskIndex(init.workspace, "T-001", () =>
      validIndex({
        counts: { runs: 1, reviewAttempts: 1 },
        warnings: [
          {
            code: "review_max_cycles_reached",
            message: "max",
            path: "T-001#R-001"
          },
          {
            code: "other",
            message: "keep"
          }
        ]
      })
    );

    await recordReviewCompletionReason({
      workspace: init.workspace,
      taskId: "T-001",
      reviewBlockRef: "T-001#R-002",
      completionReason: "max_cycles_reached",
      warning: {
        code: "review_max_cycles_reached",
        message: "another",
        path: "T-001#R-002"
      }
    });

    let index = await readTaskIndex(init.workspace, "T-001");
    expect(index.reviewCompletionReasonByBlock).toMatchObject({
      "T-001#R-001": "passed",
      "T-001#R-002": "max_cycles_reached"
    });
    expect(index.warnings).toHaveLength(3);

    const nextCounts = incrementTaskIndexCount(index, "runs");
    expect(nextCounts).toEqual({
      runs: 2,
      reviewAttempts: 1
    });

    await clearReviewCompletionReason(init.workspace, "T-001", "T-001#R-001");
    index = await readTaskIndex(init.workspace, "T-001");
    expect(index.reviewCompletionReasonByBlock).toEqual({
      "T-001#R-002": "max_cycles_reached"
    });
    expect(index.warnings?.map((warning) => warning.path)).toEqual([undefined, "T-001#R-002"]);
  });

  it("does not lose concurrent updateTaskIndex increments", async () => {
    const { init } = await createTestWorkspace();
    const increments = 20;
    await Promise.all(
      Array.from({ length: increments }, () =>
        updateTaskIndex(init.workspace, "T-001", (index) => ({
          ...index,
          counts: incrementTaskIndexCount(index, "runs")
        }))
      )
    );
    const final = await readTaskIndex(init.workspace, "T-001");
    expect(final.counts?.runs).toBe(increments);
  });
});

describe("doctor corrupt task result index", () => {
  it("reports task_result_index_invalid for schema-invalid indexes without treating them as empty", async () => {
    const { root, init } = await createTestWorkspace();
    const indexPath = join(init.workspace.resultsDir, "T-001", "index.json");
    await mkdir(join(init.workspace.resultsDir, "T-001"), { recursive: true });
    await writeJsonFile(indexPath, {
      latestRunByBlock: { "T-001#B-001": "RUN-001" },
      counts: { runs: -1 }
    });

    const report = await runDoctor({ projectRoot: root });
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "task_result_index_invalid",
          taskId: "T-001",
          path: indexPath,
          repaired: false
        })
      ])
    );
    expect(report.issues.some((issue) => issue.code === "index_state_mismatch")).toBe(false);
  });

  it("reports task_result_index_invalid for malformed JSON indexes", async () => {
    const { root, init } = await createTestWorkspace();
    const indexPath = join(init.workspace.resultsDir, "T-001", "index.json");
    await mkdir(join(init.workspace.resultsDir, "T-001"), { recursive: true });
    await writeFile(indexPath, "{not-json", "utf8");

    const report = await runDoctor({ projectRoot: root });
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "task_result_index_invalid",
          taskId: "T-001",
          path: indexPath,
          message: expect.stringContaining("malformed JSON")
        })
      ])
    );
  });
});
