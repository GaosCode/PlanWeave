import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RETENTION_DOCTOR_THRESHOLD,
  applyPrunePlan,
  computePrunePlan,
  countRetentionArtifacts,
  createRunSession,
  listRunSessions,
  updateRunSession
} from "../runSessions/index.js";
import { runDoctor } from "../taskManager/index.js";
import { writeJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

async function writeRunDir(options: {
  resultsDir: string;
  taskId: string;
  blockId: string;
  runId: string;
  submittedAt: string;
  ref?: string;
}): Promise<string> {
  const runDir = join(
    options.resultsDir,
    options.taskId,
    "blocks",
    options.blockId,
    "runs",
    options.runId
  );
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "report.md"), `report for ${options.runId}\n`, "utf8");
  await writeJsonFile(join(runDir, "metadata.json"), {
    ref: options.ref ?? `${options.taskId}#${options.blockId}`,
    taskId: options.taskId,
    blockId: options.blockId,
    runId: options.runId,
    submittedAt: options.submittedAt
  });
  return runDir;
}

describe("run session / results retention", () => {
  it("computePrunePlan excludes lastRunId and in-flight sessions", async () => {
    const { root, init } = await createTestWorkspace();
    const resultsDir = init.workspace.resultsDir;

    await writeRunDir({
      resultsDir,
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      submittedAt: "2026-01-01T00:00:00.000Z"
    });
    await writeRunDir({
      resultsDir,
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-002",
      submittedAt: "2026-02-01T00:00:00.000Z"
    });
    await writeRunDir({
      resultsDir,
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-003",
      submittedAt: "2026-03-01T00:00:00.000Z"
    });

    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": { status: "completed", lastRunId: "RUN-003" }
      },
      feedback: {}
    });
    await writeJsonFile(join(resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-003" },
      counts: { runs: 3 }
    });

    const oldSession = await createRunSession({
      projectRoot: root,
      kind: "run",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    await updateRunSession(root, oldSession.sessionId, {
      phase: "completed",
      finishedAt: "2026-01-01T01:00:00.000Z"
    });
    await createRunSession({
      projectRoot: root,
      kind: "run",
      now: new Date("2026-06-01T00:00:00.000Z")
    }); // in-flight created

    const plan = await computePrunePlan(root, {
      olderThan: "1d",
      now: new Date("2026-06-10T00:00:00.000Z")
    });

    const runIds = plan.items.filter((item) => item.kind === "run").map((item) => item.id);
    const sessionIds = plan.items.filter((item) => item.kind === "session").map((item) => item.id);

    expect(runIds).toContain("RUN-001");
    expect(runIds).toContain("RUN-002");
    expect(runIds).not.toContain("RUN-003");
    expect(sessionIds).toContain(oldSession.sessionId);
    expect(sessionIds).not.toContain("SESSION-0002");
    expect(plan.items.every((item) => item.reason.length > 0)).toBe(true);
  });

  it("keep-last retains newest terminal items per container", async () => {
    const { root, init } = await createTestWorkspace();
    const resultsDir = init.workspace.resultsDir;

    for (const [runId, at] of [
      ["RUN-001", "2026-01-01T00:00:00.000Z"],
      ["RUN-002", "2026-02-01T00:00:00.000Z"],
      ["RUN-003", "2026-03-01T00:00:00.000Z"],
      ["RUN-004", "2026-04-01T00:00:00.000Z"]
    ] as const) {
      await writeRunDir({ resultsDir, taskId: "T-001", blockId: "B-001", runId, submittedAt: at });
    }
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": { status: "completed", lastRunId: "RUN-004" }
      },
      feedback: {}
    });
    await writeJsonFile(join(resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-004" }
    });

    const plan = await computePrunePlan(root, { keepLast: 2 });
    const runIds = plan.items
      .filter((item) => item.kind === "run")
      .map((item) => item.id)
      .sort();
    // latest RUN-004 always protected; keep-last 2 among remaining newest-first keeps RUN-003
    // so only RUN-001 and RUN-002 are beyond keep-last after newest sort of unprotected?
    // Actually keep-last is applied to the whole container including protected.
    // Newest first: RUN-004, RUN-003, RUN-002, RUN-001
    // indexFromNewest >= 2 → RUN-002, RUN-001
    // RUN-004 protected so excluded; RUN-003 not beyond keep-last
    expect(runIds).toEqual(["RUN-001", "RUN-002"]);
  });

  it("applyPrunePlan deletes exactly the planned set and second dry-run is empty", async () => {
    const { root, init } = await createTestWorkspace();
    const resultsDir = init.workspace.resultsDir;

    const oldRun = await writeRunDir({
      resultsDir,
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001",
      submittedAt: "2026-01-01T00:00:00.000Z"
    });
    const currentRun = await writeRunDir({
      resultsDir,
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-002",
      submittedAt: "2026-05-01T00:00:00.000Z"
    });
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": { status: "completed", lastRunId: "RUN-002" }
      },
      feedback: {}
    });
    await writeJsonFile(join(resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-002" }
    });

    const session = await createRunSession({
      projectRoot: root,
      kind: "run",
      now: new Date("2026-01-02T00:00:00.000Z")
    });
    await updateRunSession(root, session.sessionId, {
      phase: "completed",
      finishedAt: "2026-01-02T01:00:00.000Z"
    });

    const plan = await computePrunePlan(root, {
      olderThan: "30d",
      now: new Date("2026-06-01T00:00:00.000Z")
    });
    expect(plan.items.map((item) => item.id).sort()).toEqual(["RUN-001", "SESSION-0001"]);

    const applied = await applyPrunePlan(root, plan, {
      reason: "test prune of superseded artifacts"
    });
    expect(applied.deleted.map((item) => item.id).sort()).toEqual(["RUN-001", "SESSION-0001"]);
    expect(applied.skipped).toEqual([]);
    expect(applied.reason).toBe("test prune of superseded artifacts");

    await expect(access(oldRun)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(currentRun)).resolves.toBeUndefined();
    const remainingSessions = await listRunSessions(root);
    expect(remainingSessions.sessions).toEqual([]);

    const second = await computePrunePlan(root, {
      olderThan: "30d",
      now: new Date("2026-06-01T00:00:00.000Z")
    });
    expect(second.items).toEqual([]);
  });

  it("requires a non-empty reason for applyPrunePlan", async () => {
    const { root } = await createTestWorkspace();
    const plan = await computePrunePlan(root, { keepLast: 0 });
    await expect(applyPrunePlan(root, plan, { reason: "   " })).rejects.toThrow(
      /non-empty reason/i
    );
  });

  it("doctor warns when retention artifact count exceeds the threshold without failing ok alone", async () => {
    const { root, init } = await createTestWorkspace();
    const resultsDir = init.workspace.resultsDir;

    // Seed enough run dirs to exceed the threshold while keeping state consistent.
    const count = RETENTION_DOCTOR_THRESHOLD + 5;
    for (let i = 1; i <= count; i += 1) {
      const runId = `RUN-${String(i).padStart(3, "0")}`;
      await writeRunDir({
        resultsDir,
        taskId: "T-001",
        blockId: "B-001",
        runId,
        submittedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`
      });
    }
    const latest = `RUN-${String(count).padStart(3, "0")}`;
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": { status: "completed", lastRunId: latest }
      },
      feedback: {}
    });
    await writeJsonFile(join(resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": latest },
      counts: { runs: count }
    });

    const totals = await countRetentionArtifacts(root);
    expect(totals.total).toBeGreaterThan(RETENTION_DOCTOR_THRESHOLD);

    const report = await runDoctor({ projectRoot: root });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "retention_threshold_exceeded",
          severity: "warning",
          threshold: RETENTION_DOCTOR_THRESHOLD
        })
      ])
    );
  });
});
