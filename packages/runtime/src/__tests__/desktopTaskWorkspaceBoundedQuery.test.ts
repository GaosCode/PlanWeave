import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import * as optionalFile from "../fs/optionalFile.js";
import * as jsonFile from "../json.js";
import * as packageLoader from "../package/loadPackage.js";
import {
  TASK_WORKSPACE_RUNS_DEFAULT_LIMIT,
  TASK_WORKSPACE_RUNS_MAX_LIMIT,
  composeTaskWorkspaceRuns,
  desktopRunRecordSchema,
  getTaskWorkspace,
  getTaskWorkspaceRunDetail,
  listTaskFeedbackRunRecords,
  listTaskWorkspaceRuns,
  taskWorkspaceListRunsInputSchema,
  taskWorkspaceRunDetailSchema,
  taskWorkspaceRunsCursorSchema,
  taskWorkspaceRunDetailInputSchema
} from "../desktop/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import {
  initializeBlockRunIndex,
  migrateBlockRunIndexes,
  readBlockRunIndexHead,
  removeBlockRunFromIndex,
  recordBlockRunArtifactInIndex,
  recordBlockRunInIndex,
  type BlockRunIndexWriteStage
} from "../autoRun/blockRunIndex.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  vi.restoreAllMocks();
});

describe("block run index crash recovery", () => {
  it.each<BlockRunIndexWriteStage>([
    "generation-created",
    "pages-written",
    "before-publish",
    "published"
  ])("recovers and retries after a crash at %s", async (failedStage) => {
    const { init } = await createTestWorkspace(basicManifest());
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    await mkdir(join(runRoot, "RUN-001"), { recursive: true });
    await recordBlockRunInIndex(runRoot, "RUN-001");
    await mkdir(join(runRoot, "RUN-002"), { recursive: true });

    await expect(
      recordBlockRunInIndex(runRoot, "RUN-002", {
        afterStage(stage) {
          if (stage === failedStage) throw new Error(`crash:${stage}`);
        }
      })
    ).rejects.toThrow(`crash:${failedStage}`);

    await expect(readBlockRunIndexHead(runRoot)).resolves.toMatchObject({
      runId: failedStage === "published" ? "RUN-002" : "RUN-001"
    });
    await recordBlockRunInIndex(runRoot, "RUN-002");
    await expect(readBlockRunIndexHead(runRoot)).resolves.toMatchObject({ runId: "RUN-002", retryIndex: 2 });
  });

  it("explicitly migrates legacy runs and recovers the latest report artifact", async () => {
    const { root, init } = await createTestWorkspace();
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    await mkdir(join(runRoot, "RUN-001"), { recursive: true });
    await writeJsonFile(join(runRoot, "RUN-001", "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#B-001",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 0
    });
    await writeFile(join(runRoot, "RUN-001", "report.md"), "legacy report", "utf8");
    const reviewRunRoot = join(init.workspace.resultsDir, "T-001", "blocks", "R-001", "runs");
    await mkdir(join(reviewRunRoot, "RUN-001"), { recursive: true });
    await writeJsonFile(join(reviewRunRoot, "RUN-001", "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#R-001",
      startedAt: "2026-01-02T00:00:00.000Z",
      finishedAt: "2026-01-02T00:00:01.000Z"
    });

    await expect(migrateBlockRunIndexes(root)).resolves.toMatchObject({
      indexedBlocks: 2,
      indexedRuns: 2
    });
    const workspace = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    expect(workspace.latestArtifact).toMatchObject({
      recordId: "T-001#B-001::RUN-001",
      legacy: true
    });
  });
});

async function writeLightRun(options: {
  resultsDir: string;
  blockId: string;
  runId: string;
  startedAt?: string;
  finishedAt?: string | null;
  heavy?: boolean;
}): Promise<void> {
  const ref = `T-001#${options.blockId}`;
  const runDir = join(
    options.resultsDir,
    "T-001",
    "blocks",
    options.blockId,
    "runs",
    options.runId
  );
  await mkdir(runDir, { recursive: true });
  const startedAt = options.startedAt ?? "2026-07-13T00:00:00.000Z";
  const finishedAt =
    options.finishedAt === undefined
      ? new Date(Date.parse(startedAt) + 1_000).toISOString()
      : options.finishedAt;
  await writeJsonFile(join(runDir, "metadata.json"), {
    runId: options.runId,
    ref,
    executor: "codex",
    adapter: "codex-exec",
    startedAt,
    finishedAt,
    exitCode: finishedAt === null ? null : 0
  });
  await recordBlockRunInIndex(join(options.resultsDir, "T-001", "blocks", options.blockId, "runs"), options.runId);
  if (options.heavy) {
    await writeFile(join(runDir, "prompt.md"), "HEAVY_PROMPT_CONTENT\n".repeat(20), "utf8");
    await writeFile(join(runDir, "stdout.md"), "HEAVY_STDOUT_CONTENT\n".repeat(20), "utf8");
    await writeFile(join(runDir, "stderr.log"), "HEAVY_STDERR_CONTENT\n".repeat(5), "utf8");
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify({
        version: "planweave.runner-event/v1",
        sequence: 1,
        timestamp: "2026-07-13T00:00:00.000Z",
        identity: {
          projectId: "x",
          canvasId: "default",
          taskId: "T-001",
          blockId: options.blockId,
          claimRef: ref,
          runId: options.runId,
          runOwner: "executor",
          runSessionId: null,
          desktopRunId: null,
          executorRunId: options.runId
        },
        runner: { version: "planweave.runner/v1", runnerKind: "cli", agentId: "codex" },
        body: { kind: "lifecycle", state: "running", message: "Running" }
      })}\n`,
      "utf8"
    );
  }
}

describe("Task Workspace bounded query contract", () => {
  it("validates limit and cursor at the Zod boundary", () => {
    expect(
      taskWorkspaceListRunsInputSchema.safeParse({
        projectRoot: "/tmp",
        canvasId: "default",
        taskId: "T-001",
        limit: 0
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceListRunsInputSchema.safeParse({
        projectRoot: "/tmp",
        canvasId: "default",
        taskId: "T-001",
        limit: TASK_WORKSPACE_RUNS_MAX_LIMIT + 1
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceListRunsInputSchema.safeParse({
        projectRoot: "/tmp",
        canvasId: "default",
        taskId: "T-001",
        limit: TASK_WORKSPACE_RUNS_MAX_LIMIT
      }).success
    ).toBe(true);
    expect(
      taskWorkspaceRunsCursorSchema.safeParse({
        version: "planweave.task-workspace-runs-cursor/v2",
        taskId: "T-001",
        canvasId: "default",
        orderedAt: "2026-07-13T00:00:00.000Z",
        recordId: "T-001#B-001::RUN-001"
      }).success
    ).toBe(true);
    expect(
      taskWorkspaceRunsCursorSchema.safeParse({
        version: "wrong",
        taskId: "T-001",
        canvasId: "default",
        orderedAt: "2026-07-13T00:00:00.000Z",
        recordId: "T-001#B-001::RUN-001"
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceRunsCursorSchema.safeParse({
        version: "planweave.task-workspace-runs-cursor/v2",
        taskId: "T-001",
        canvasId: "default",
        orderedAt: "2026-07-13T00:00:00.000Z",
        recordId: "not-a-record-id"
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceRunsCursorSchema.safeParse({
        version: "planweave.task-workspace-runs-cursor/v2",
        taskId: "T-001",
        canvasId: "default",
        recordId: "T-001#B-001::RUN-001"
      }).success
    ).toBe(false);
    // Feedback recordIds are syntactically valid run ids but not page cursors.
    expect(
      taskWorkspaceRunsCursorSchema.safeParse({
        version: "planweave.task-workspace-runs-cursor/v2",
        taskId: "T-001",
        canvasId: "default",
        orderedAt: "2026-07-13T00:00:00.000Z",
        recordId: "FE-001::RUN-002"
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceListRunsInputSchema.safeParse({
        projectRoot: "/tmp",
        canvasId: "default",
        taskId: "T-001",
        cursor: {
          version: "planweave.task-workspace-runs-cursor/v2",
          taskId: "T-001",
          canvasId: "default",
          orderedAt: "2026-07-13T00:00:00.000Z",
          recordId: "FE-001::RUN-002"
        }
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceRunDetailInputSchema.safeParse({
        projectRoot: "/tmp",
        canvasId: "default",
        taskId: "T-001"
      }).success
    ).toBe(false);
  });

  it("rejects cross-task and foreign-block cursors without changing page results", async () => {
    const { root, init } = await createTestWorkspace();
    for (const runId of ["RUN-001", "RUN-002", "RUN-003"]) {
      await writeLightRun({
        resultsDir: init.workspace.resultsDir,
        blockId: "B-001",
        runId
      });
    }

    await expect(
      listTaskWorkspaceRuns({
        projectRoot: root,
        canvasId: "default",
        taskId: "T-001",
        limit: 2,
        cursor: {
          version: "planweave.task-workspace-runs-cursor/v2",
          taskId: "T-001",
          canvasId: "default",
          orderedAt: "2026-07-13T00:00:00.000Z",
          recordId: "T-OTHER#B-999::RUN-002",
        }
      })
    ).rejects.toThrow(/does not belong to task 'T-001'/);

    await expect(
      listTaskWorkspaceRuns({
        projectRoot: root,
        canvasId: "default",
        taskId: "T-001",
        limit: 2,
        cursor: {
          version: "planweave.task-workspace-runs-cursor/v2",
          taskId: "T-001",
          canvasId: "default",
          orderedAt: "2026-07-13T00:00:00.000Z",
          recordId: "T-001#B-999::RUN-002",
        }
      })
    ).rejects.toThrow(/does not belong to task 'T-001'/);

    // Unscoped cursor must not silently skip RUN-003.
    const firstPage = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 2
    });
    expect(firstPage.items.map((item) => item.run.record.runId)).toEqual(["RUN-003", "RUN-002"]);
  });

  it("continues paging when the same-task cursor row was deleted", async () => {
    const { root, init } = await createTestWorkspace();
    for (const runId of ["RUN-001", "RUN-002", "RUN-003"]) {
      await writeLightRun({
        resultsDir: init.workspace.resultsDir,
        blockId: "B-001",
        runId
      });
    }

    const page1 = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 1
    });
    expect(page1.items.map((item) => item.run.record.runId)).toEqual(["RUN-003"]);
    expect(page1.nextCursor).toMatchObject({
      version: "planweave.task-workspace-runs-cursor/v2",
      taskId: "T-001",
      canvasId: "default",
      recordId: "T-001#B-001::RUN-003"
    });

    // Cursor anchors on RUN-002; delete that row. Continuation uses stable sort key.
    const deletedRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-002"
    );
    await rm(deletedRunDir, { recursive: true, force: true });

    const pageAfterDelete = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 2,
      cursor: {
        version: "planweave.task-workspace-runs-cursor/v2",
        taskId: "T-001",
        canvasId: "default",
        orderedAt: "2026-07-13T00:00:00.000Z",
        recordId: "T-001#B-001::RUN-002",
      }
    });
    expect(pageAfterDelete.items.map((item) => item.run.record.runId)).toEqual(["RUN-001"]);
    expect(pageAfterDelete.nextCursor).toBeNull();

    // Repeating the same deleted-row cursor remains stable.
    const pageAfterDeleteAgain = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 2,
      cursor: {
        version: "planweave.task-workspace-runs-cursor/v2",
        taskId: "T-001",
        canvasId: "default",
        orderedAt: "2026-07-13T00:00:00.000Z",
        recordId: "T-001#B-001::RUN-002",
      }
    });
    expect(pageAfterDeleteAgain.items.map((item) => item.run.record.recordId)).toEqual(
      pageAfterDelete.items.map((item) => item.run.record.recordId)
    );
    expect(pageAfterDeleteAgain.nextCursor).toEqual(pageAfterDelete.nextCursor);
  });

  it("pages runs with stable cursors and snapshot-like insertion semantics", async () => {
    const { root, init } = await createTestWorkspace();
    for (const runId of ["RUN-001", "RUN-002", "RUN-003", "RUN-004", "RUN-005"]) {
      await writeLightRun({
        resultsDir: init.workspace.resultsDir,
        blockId: "B-001",
        runId
      });
    }

    const page1 = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 2
    });
    expect(page1.items.map((item) => item.run.record.runId)).toEqual(["RUN-005", "RUN-004"]);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.limit).toBe(2);

    // Insert a newer run while paging — must not appear on page 2, no duplicates of page 1.
    await writeLightRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-006"
    });

    const page2 = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 2,
      cursor: page1.nextCursor
    });
    expect(page2.items.map((item) => item.run.record.runId)).toEqual(["RUN-003", "RUN-002"]);
    expect(page2.items.some((item) => item.run.record.runId === "RUN-006")).toBe(false);
    expect(page2.items.some((item) => item.run.record.runId === "RUN-005")).toBe(false);

    const refresh = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 2
    });
    expect(refresh.items.map((item) => item.run.record.runId)).toEqual(["RUN-006", "RUN-005"]);

    // Same timestamp different recordIds — stable order by recordId.
    await writeLightRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-007",
      startedAt: "2026-07-13T12:00:00.000Z"
    });
    await writeLightRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-008",
      startedAt: "2026-07-13T12:00:00.000Z"
    });
    const sameTs = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 2
    });
    expect(sameTs.items.map((item) => item.run.record.runId)).toEqual(["RUN-008", "RUN-007"]);
  });

  it("orders cross-block pages by authoritative run time instead of local run id", async () => {
    const { root, init } = await createTestWorkspace();
    await writeLightRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-999",
      startedAt: "2026-01-01T00:00:00.000Z"
    });
    await writeLightRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "R-001",
      runId: "RUN-001",
      startedAt: "2026-07-01T00:00:00.000Z"
    });

    const first = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 1
    });
    expect(first.items[0]?.run.record.recordId).toBe("T-001#R-001::RUN-001");
    expect(first.nextCursor).not.toBeNull();

    const second = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 1,
      cursor: first.nextCursor
    });
    expect(second.items[0]?.run.record.recordId).toBe("T-001#B-001::RUN-999");
    expect(second.nextCursor).toBeNull();
  });

  it("uses the durable global cursor anchor when retention shifts index offsets", async () => {
    const { root, init } = await createTestWorkspace();
    for (const runId of ["RUN-001", "RUN-002", "RUN-003"]) {
      await writeLightRun({ resultsDir: init.workspace.resultsDir, blockId: "B-001", runId });
    }
    const first = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 1
    });
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    await removeBlockRunFromIndex(runRoot, "RUN-001");
    await rm(join(runRoot, "RUN-001"), { recursive: true, force: true });

    const second = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: 1,
      cursor: first.nextCursor
    });
    expect(second.items.map((item) => item.run.record.runId)).toEqual(["RUN-002"]);
    expect(second.nextCursor).toBeNull();
  });

  it("header omits runs; detail loads heavy content only for the selected record", async () => {
    const { root, init } = await createTestWorkspace();
    for (const runId of ["RUN-001", "RUN-002", "RUN-003"]) {
      await writeLightRun({
        resultsDir: init.workspace.resultsDir,
        blockId: "B-001",
        runId,
        heavy: true
      });
    }

    const readFileSpy = vi.spyOn(optionalFile, "optionalReadFile");
    const header = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    expect(header.blocks.every((block) => block.runs.length === 0)).toBe(true);
    expect(header.selectedRecordId).toBe("T-001#B-001::RUN-003");

    const heavyReadsOnHeader = readFileSpy.mock.calls.filter(([path]) => {
      const text = String(path);
      return (
        text.endsWith("prompt.md") ||
        text.endsWith("stdout.md") ||
        text.endsWith("stderr.log") ||
        text.endsWith("events.ndjson")
      );
    });
    expect(heavyReadsOnHeader).toHaveLength(0);

    const page = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      limit: TASK_WORKSPACE_RUNS_DEFAULT_LIMIT
    });
    expect(page.items).toHaveLength(3);
    const heavyReadsOnList = readFileSpy.mock.calls.filter(([path]) => {
      const text = String(path);
      return (
        text.endsWith("prompt.md") ||
        text.endsWith("stdout.md") ||
        text.endsWith("stderr.log") ||
        text.endsWith("events.ndjson")
      );
    });
    expect(heavyReadsOnList).toHaveLength(0);

    readFileSpy.mockClear();
    const detail = await getTaskWorkspaceRunDetail({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      recordId: "T-001#B-001::RUN-002"
    });
    expect(detail.record.promptMarkdown).toContain("HEAVY_PROMPT_CONTENT");
    expect(detail.item.run.record.recordId).toBe("T-001#B-001::RUN-002");

    const heavyPaths = readFileSpy.mock.calls
      .map(([path]) => String(path))
      .filter(
        (path) =>
          path.endsWith("prompt.md") ||
          path.endsWith("stdout.md") ||
          path.endsWith("stderr.log") ||
          path.endsWith("events.ndjson")
      );
    expect(heavyPaths.every((path) => path.includes("RUN-002"))).toBe(true);
    expect(heavyPaths.some((path) => path.includes("RUN-001"))).toBe(false);
    expect(heavyPaths.some((path) => path.includes("RUN-003"))).toBe(false);

    const composed = composeTaskWorkspaceRuns(header, page.items);
    expect(composed.blocks[0]?.runs).toHaveLength(3);

    await expect(
      getTaskWorkspaceRunDetail({
        projectRoot: root,
        canvasId: "default",
        taskId: "T-001",
        recordId: "T-999#B-001::RUN-001"
      })
    ).rejects.toThrow(/does not belong|missing/i);
  });

  it("keeps first-load heavy I/O bounded for 10k synthetic runs", async () => {
    const { root, init } = await createTestWorkspace(basicManifest());
    const runsRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    await mkdir(runsRoot, { recursive: true });
    // Generate 10k run directories. Heavy content files exist only on a subset so the
    // fixture stays cheap while still proving first-load never opens those paths.
    const total = 10_000;
    const writes: Promise<void>[] = [];
    for (let i = 1; i <= total; i += 1) {
      const runId = `RUN-${String(i).padStart(5, "0")}`;
      const runDir = join(runsRoot, runId);
      writes.push(
        (async () => {
          await mkdir(runDir, { recursive: true });
          await writeJsonFile(join(runDir, "metadata.json"), {
            runId,
            ref: "T-001#B-001",
            executor: "codex",
            adapter: "codex-exec",
            startedAt: "2026-07-13T00:00:00.000Z",
            finishedAt: "2026-07-13T00:00:01.000Z",
            exitCode: 0
          });
          if (i > total - 100) {
            await writeFile(join(runDir, "prompt.md"), "P", "utf8");
            await writeFile(join(runDir, "stdout.md"), "O", "utf8");
            await writeFile(join(runDir, "stderr.log"), "E", "utf8");
          }
        })()
      );
      if (writes.length >= 200) {
        await Promise.all(writes);
        writes.length = 0;
      }
    }
    await Promise.all(writes);

    await initializeBlockRunIndex(runsRoot);

    const readFileSpy = vi.spyOn(optionalFile, "optionalReadFile");
    const readdirSpy = vi.spyOn(optionalFile, "optionalReaddir");
    const statSpy = vi.spyOn(optionalFile, "optionalStat");
    const jsonSpy = vi.spyOn(jsonFile, "readJsonFile");
    const packageSpy = vi.spyOn(packageLoader, "loadPackage");
    const ioCounts = () => ({
      metadata: jsonSpy.mock.calls.filter(([path]) => String(path).endsWith("metadata.json")).length,
      packages: packageSpy.mock.calls.length,
      readdir: readdirSpy.mock.calls.length,
      stat: statSpy.mock.calls.length
    });
    const expectBoundedDelta = (before: ReturnType<typeof ioCounts>) => {
      const after = ioCounts();
      expect(after.metadata - before.metadata).toBeLessThanOrEqual(
        TASK_WORKSPACE_RUNS_DEFAULT_LIMIT + 8
      );
      expect(after.packages - before.packages).toBeLessThanOrEqual(
        TASK_WORKSPACE_RUNS_DEFAULT_LIMIT + 24
      );
      expect(after.readdir - before.readdir).toBeLessThanOrEqual(
        TASK_WORKSPACE_RUNS_DEFAULT_LIMIT * 2 + 12
      );
      expect(after.stat - before.stat).toBeLessThanOrEqual(
        TASK_WORKSPACE_RUNS_DEFAULT_LIMIT * 6 + 40
      );
      return after;
    };
    const beforeFirstLoad = ioCounts();
    const header = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    const page = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    const afterFirstLoad = expectBoundedDelta(beforeFirstLoad);

    const older = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      cursor: page.nextCursor
    });
    const afterOlder = expectBoundedDelta(afterFirstLoad);
    expect(older.items).toHaveLength(TASK_WORKSPACE_RUNS_DEFAULT_LIMIT);

    await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    expectBoundedDelta(afterOlder);

    readFileSpy.mockClear();
    const distant = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      cursor: {
        version: "planweave.task-workspace-runs-cursor/v2",
        taskId: "T-001",
        canvasId: "default",
        orderedAt: "2026-07-13T00:00:00.000Z",
        recordId: "T-001#B-001::RUN-05000"
      }
    });
    expect(distant.items[0]?.run.record.runId).toBe("RUN-04999");
    const indexPageReads = readFileSpy.mock.calls.filter(([path]) => {
      const text = String(path);
      return text.includes(".planweave-task-workspace-run-index/generations/") &&
        /page-\d+\.json$/.test(text);
    });
    expect(indexPageReads.length).toBeLessThanOrEqual(12);

    expect(header.blocks[0]?.runs).toEqual([]);
    expect(page.limit).toBe(TASK_WORKSPACE_RUNS_DEFAULT_LIMIT);
    expect(page.items).toHaveLength(TASK_WORKSPACE_RUNS_DEFAULT_LIMIT);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items[0]?.run.record.runId).toBe("RUN-10000");

    const heavyReads = readFileSpy.mock.calls.filter(([path]) => {
      const text = String(path);
      return (
        text.endsWith("prompt.md") ||
        text.endsWith("stdout.md") ||
        text.endsWith("stderr.log") ||
        text.endsWith("events.ndjson")
      );
    });
    expect(heavyReads).toHaveLength(0);
    expect(
      readdirSpy.mock.calls.filter(([path]) => String(path) === runsRoot)
    ).toHaveLength(0);

    // Payload entry count is page-bounded, not total-history-bounded.
    expect(page.items.length).toBeLessThanOrEqual(TASK_WORKSPACE_RUNS_DEFAULT_LIMIT);
    expect(JSON.stringify(page).length).toBeLessThan(JSON.stringify(page.items).length * 3 + 2_000);
  }, 120_000);

  it("fails closed without scanning legacy run history when the bounded index is missing", async () => {
    const { root, init } = await createTestWorkspace();
    const runsRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    await mkdir(join(runsRoot, "RUN-001"), { recursive: true });
    await writeJsonFile(join(runsRoot, "RUN-001", "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#B-001",
      executor: "codex",
      adapter: "codex-exec",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
      exitCode: 0
    });

    const readdirSpy = vi.spyOn(optionalFile, "optionalReaddir");
    await expect(
      listTaskWorkspaceRuns({
        projectRoot: root,
        canvasId: "default",
        taskId: "T-001"
      })
    ).rejects.toThrow(/run index is missing/i);
    expect(readdirSpy.mock.calls.filter(([path]) => String(path) === runsRoot)).toHaveLength(0);
  });

  it("resolves latestArtifact from full history, not only the newest page window", async () => {
    const { root, init } = await createTestWorkspace();
    for (let i = 1; i <= 51; i += 1) {
      const runId = `RUN-${String(i).padStart(3, "0")}`;
      await writeLightRun({
        resultsDir: init.workspace.resultsDir,
        blockId: "B-001",
        runId
      });
    }
    await writeFile(
      join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-001",
        "report.md"
      ),
      "# oldest report\n",
      "utf8"
    );
    await recordBlockRunArtifactInIndex(
      join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs"),
      "RUN-001"
    );

    const header = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001",
      selectedRecordId: "T-001#B-001::RUN-051"
    });
    expect(header.selectedRecordId).toBe("T-001#B-001::RUN-051");
    expect(header.latestArtifact).toMatchObject({
      recordId: "T-001#B-001::RUN-001",
      runId: "RUN-001",
      legacy: true
    });
  });

  it("does not read feedback-run stdout/stderr while building the Task Workspace header", async () => {
    const { root, init } = await createTestWorkspace();
    const reviewRef = "T-001#R-001";
    const runDir = join(init.workspace.resultsDir, "feedback-runs", "RUN-FB-001");
    await mkdir(runDir, { recursive: true });
    await writeJsonFile(join(runDir, "metadata.json"), {
      runId: "RUN-FB-001",
      feedbackId: "FE-001",
      sourceReviewBlockRef: reviewRef,
      taskId: "T-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
      exitCode: 0
    });
    await writeFile(join(runDir, "stdout.md"), "FEEDBACK_STDOUT\n".repeat(20), "utf8");
    await writeFile(join(runDir, "stderr.log"), "FEEDBACK_STDERR\n".repeat(5), "utf8");

    const readFileSpy = vi.spyOn(optionalFile, "optionalReadFile");
    const header = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    const summaries = await listTaskFeedbackRunRecords(root, "default", "T-001");

    expect(summaries).toEqual([
      expect.objectContaining({
        feedbackId: "FE-001",
        sourceReviewBlockRef: reviewRef,
        stdoutSummary: "",
        stderrSummary: ""
      })
    ]);
    expect(
      header.blocks
        .find((block) => block.ref === reviewRef)
        ?.annotations.some((annotation) => annotation.kind === "feedback_run")
    ).toBe(true);

    const heavyReads = readFileSpy.mock.calls.filter(([path]) => {
      const text = String(path);
      return text.endsWith("stdout.md") || text.endsWith("stderr.log");
    });
    expect(heavyReads).toHaveLength(0);
  });

  it("rejects invalid selected-run detail payloads at the shared Zod boundary", () => {
    const base = {
      version: "planweave.task-workspace-run-detail/v1" as const,
      projectRoot: "/tmp",
      canvasId: "default",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      item: {
        retryIndex: 1,
        active: false,
        selected: true,
        waitingInteraction: { active: false as const, count: 0 as const, kinds: [] as [] },
        run: {
          version: "planweave.task-workspace-run/v1" as const,
          kind: "block" as const,
          record: {
            recordId: "T-001#B-001::RUN-001",
            ref: "T-001#B-001",
            taskId: "T-001",
            blockId: "B-001",
            runId: "RUN-001"
          },
          runIdentity: {
            projectId: "p",
            canvasId: "default",
            taskId: "T-001",
            blockId: "B-001",
            claimRef: "T-001#B-001",
            runId: "RUN-001",
            runOwner: "executor" as const,
            runSessionId: null,
            desktopRunId: null,
            executorRunId: "RUN-001"
          },
          metadata: {
            executor: null,
            adapter: null,
            runnerKind: null,
            agentId: null,
            executionCwd: null,
            projectRoot: null,
            agentSessionId: null,
            tmuxSessionId: null,
            exitCode: null,
            terminalState: null
          },
          executionWaveId: null,
          duration: {
            startedAt: null,
            finishedAt: null,
            calculatedAt: "2026-07-13T00:00:00.000Z",
            wallClockMs: null,
            unavailableReason: "missing"
          },
          usage: {
            currentContext: null,
            runTokens: { available: false as const, totalTokens: null, reason: "n/a" },
            runCost: { available: false as const, totals: null, reason: "n/a" }
          },
          actualConfiguration: { available: false as const, reason: "n/a" },
          capabilities: {
            prompt: {
              available: false,
              reason: "n/a",
              identity: null,
              inFlight: false
            },
            cancel: { available: false, reason: "n/a", identity: null },
            retry: { available: false, reason: "n/a", identity: null },
            resume: { available: false, reason: "n/a", identity: null }
          }
        }
      },
      record: {
        recordId: "T-001#B-001::RUN-001",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        runId: "RUN-001",
        executor: null,
        adapter: null,
        executionCwd: null,
        projectRoot: null,
        agentSessionId: null,
        codexSessionId: null,
        exitCode: null,
        startedAt: null,
        finishedAt: null,
        promptPath: null,
        reportPath: null,
        metadataPath: "/tmp/metadata.json",
        stdoutSummary: "",
        stderrSummary: "",
        promptMarkdown: "",
        reportMarkdown: "",
        displayMarkdown: "",
        displayMarkdownSource: "none" as const,
        metadata: {},
        runnerReadModel: 42
      }
    };

    expect(desktopRunRecordSchema.safeParse(base.record).success).toBe(false);
    expect(taskWorkspaceRunDetailSchema.safeParse(base).success).toBe(false);
    expect(
      desktopRunRecordSchema.safeParse({
        ...base.record,
        runnerReadModel: null,
        unexpectedExtra: true
      }).success
    ).toBe(false);
  });
});
