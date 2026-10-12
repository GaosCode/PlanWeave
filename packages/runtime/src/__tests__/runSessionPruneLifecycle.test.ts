import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonFile } from "../json.js";
import { discardRunSessionInitialization } from "../runSessions/repository.js";
import {
  appendRunSessionEvent,
  applyPrunePlan,
  computePrunePlan,
  createRunSession,
  getRunSession,
  listRunSessions,
  updateRunSession
} from "../runSessions/index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const directories: string[] = [];
let previousHome: string | undefined;
let previousSettings: string | undefined;
beforeEach(() => {
  previousHome = process.env.PLANWEAVE_HOME;
  previousSettings = process.env.PLANWEAVE_SETTINGS_FILE;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = previousHome;
  if (previousSettings === undefined) delete process.env.PLANWEAVE_SETTINGS_FILE;
  else process.env.PLANWEAVE_SETTINGS_FILE = previousSettings;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture() {
  const workspace = await createTestWorkspace();
  directories.push(workspace.root, workspace.home);
  return workspace;
}

describe("session lifetime across retention", () => {
  it("never reuses a pruned id and rejects old writes without changing a fresh session", async () => {
    const { init } = await fixture();
    const workspace = init.workspace;
    const old = await createRunSession({ projectRoot: workspace, kind: "run" });
    await updateRunSession(workspace, old.sessionId, { phase: "completed" });
    const plan = await computePrunePlan(workspace, { keepLast: 0 });
    expect(
      (await applyPrunePlan(workspace, plan, { reason: "retire old session" })).deleted
    ).toEqual([expect.objectContaining({ id: old.sessionId })]);
    const fresh = await createRunSession({ projectRoot: workspace, kind: "run", trigger: "api" });
    const freshRoot = join(workspace.resultsDir, "run-sessions", fresh.sessionId);
    const before = await Promise.all(
      ["session.json", "events.ndjson"].map((file) => readFile(join(freshRoot, file), "utf8"))
    );

    const outcomes = await Promise.allSettled([
      updateRunSession(workspace, old.sessionId, { phase: "failed", error: "retired owner" }),
      appendRunSessionEvent(workspace, old.sessionId, "retired_event"),
      discardRunSessionInitialization(workspace, old.sessionId)
    ]);

    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(
      await Promise.all(
        ["session.json", "events.ndjson"].map((file) => readFile(join(freshRoot, file), "utf8"))
      )
    ).toEqual(before);
    await expect(
      access(join(workspace.resultsDir, "run-sessions", old.sessionId))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listRunSessions(workspace)).diagnostics).toEqual([]);
  });

  it("does not resurrect a pruned session when an event or update arrives without a successor", async () => {
    const { init } = await fixture();
    const workspace = init.workspace;
    const old = await createRunSession({ projectRoot: workspace, kind: "run" });
    await updateRunSession(workspace, old.sessionId, { phase: "completed" });
    await applyPrunePlan(workspace, await computePrunePlan(workspace, { keepLast: 0 }), {
      reason: "retire the only session"
    });
    await expect(
      appendRunSessionEvent(workspace, old.sessionId, "late_completion")
    ).rejects.toThrow();
    await expect(updateRunSession(workspace, old.sessionId, { phase: "failed" })).rejects.toThrow();
    await expect(
      access(join(workspace.resultsDir, "run-sessions", old.sessionId))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listRunSessions(workspace)).toEqual({ sessions: [], diagnostics: [] });
  });

  it("captures legacy high water before pruning the last persisted session", async () => {
    const { root, init } = await fixture();
    const path = join(init.workspace.resultsDir, "run-sessions", "SESSION-0042");
    await mkdir(path, { recursive: true });
    await writeJsonFile(join(path, "session.json"), {
      sessionId: "SESSION-0042",
      kind: "run",
      trigger: "manual",
      projectRoot: root,
      canvasId: "default",
      scope: { kind: "project" },
      phase: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z",
      finishedAt: "2026-01-01T01:00:00.000Z",
      reset: null,
      autoRun: null,
      latestRecordId: null,
      latestRecordPath: null,
      error: null
    });
    expect((await getRunSession(root, "SESSION-0042")).diagnostics).toEqual([]);
    await applyPrunePlan(root, await computePrunePlan(root, { keepLast: 0 }), {
      reason: "prune legacy terminal session"
    });
    const fresh = await createRunSession({ projectRoot: root, kind: "run" });
    expect(fresh.sessionId).toBe("SESSION-0043");
  });

  it.each([
    "desktop",
    "executor"
  ] as const)("initializes allocation from a retained %s reference after legacy summaries are absent", async (owner) => {
    const { root, init } = await fixture();
    const directory =
      owner === "desktop"
        ? join(init.workspace.resultsDir, "auto-runs", "DESKTOP-RUN-0001")
        : join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await mkdir(directory, { recursive: true });
    await writeJsonFile(join(directory, owner === "desktop" ? "state.json" : "metadata.json"), {
      runSessionId: "SESSION-0042"
    });
    const fresh = await createRunSession({ projectRoot: root, kind: "run" });
    expect(fresh.sessionId).toBe("SESSION-0043");
  });

  it("rechecks the age rule when a planned terminal session becomes recent", async () => {
    const { root, init } = await fixture();
    const old = await createRunSession({
      projectRoot: root,
      kind: "run",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    await updateRunSession(root, old.sessionId, {
      phase: "completed",
      finishedAt: "2026-01-01T01:00:00.000Z"
    });
    const plan = await computePrunePlan(root, {
      olderThan: "1d",
      now: new Date("2026-06-01T00:00:00.000Z")
    });
    await updateRunSession(root, old.sessionId, { finishedAt: "2026-06-01T00:00:00.000Z" });
    const path = join(init.workspace.resultsDir, "run-sessions", old.sessionId, "session.json");
    const before = await readFile(path, "utf8");
    const applied = await applyPrunePlan(root, plan, { reason: "old eligibility snapshot" });
    expect(applied.deleted).toEqual([]);
    expect(applied.skipped).toEqual([expect.objectContaining({ id: old.sessionId })]);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rejects replayed plan items when a session directory is replaced at the same path", async () => {
    const { root, init } = await fixture();
    const old = await createRunSession({ projectRoot: root, kind: "run" });
    await updateRunSession(root, old.sessionId, { phase: "completed" });
    const plan = await computePrunePlan(root, { keepLast: 0 });
    await applyPrunePlan(root, plan, { reason: "first application" });
    const path = join(init.workspace.resultsDir, "run-sessions", old.sessionId);
    await mkdir(path);
    await writeJsonFile(join(path, "session.json"), {
      ...old,
      phase: "completed",
      trigger: "api",
      startedAt: "2026-10-12T00:00:00.000Z"
    });
    const before = await readFile(join(path, "session.json"), "utf8");
    const applied = await applyPrunePlan(root, plan, { reason: "replayed old plan" });
    expect(applied.deleted).toEqual([]);
    expect(applied.skipped).toEqual([expect.objectContaining({ id: old.sessionId })]);
    expect(await readFile(join(path, "session.json"), "utf8")).toBe(before);
  });
});
