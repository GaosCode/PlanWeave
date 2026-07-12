import type { PathLike } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsObservations = vi.hoisted(() => ({
  readdirPaths: [] as string[]
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (path: PathLike, ...args: unknown[]) => {
      fsObservations.readdirPaths.push(path.toString());
      return actual.readdir(
        path,
        ...(args as Parameters<typeof actual.readdir> extends [PathLike, ...infer Rest]
          ? Rest
          : never)
      );
    }
  };
});

import {
  createTaskCanvas,
  getAutoRunState,
  getLatestAutoRunSummaryWithDiagnostics,
  getLatestAutoRunSummary,
  listAutoRunEvents,
  resolveTaskCanvasWorkspace,
  resumeAutoRun,
  shutdownDesktopAutoRuns,
  startAutoRun,
  stopAutoRun
} from "../desktop/index.js";
import { readState } from "../state.js";
import type { DesktopAutoRunState } from "../desktop/index.js";
import {
  nextPersistedAutoRunId,
  readLatestPersistedAutoRunState,
  writePersistedAutoRunState as writeRepositoryPersistedAutoRunState
} from "../desktop/runStateRepository.js";
import { initWorkspace } from "../initWorkspace.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode } from "../projectGraph/index.js";
import { writeProjectGraph } from "../projectGraph/loadProjectGraph.js";
import type { PlanPackageManifest, ProjectWorkspace } from "../types.js";
import { createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

const startedRunIds = new Set<string>();
const noTmux = { tmuxEnabled: false } as const;

afterEach(async () => {
  await Promise.all([...startedRunIds].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  startedRunIds.clear();
  fsObservations.readdirPaths = [];
  delete process.env.PLANWEAVE_HOME;
});

function persistedAutoRunState(
  workspace: ProjectWorkspace,
  patch: Partial<Omit<DesktopAutoRunState, "explanation">> = {}
): DesktopAutoRunState {
  const runId = patch.runId ?? "DESKTOP-RUN-0001";
  const runRoot = join(workspace.resultsDir, "auto-runs", runId);
  const state = {
    runId,
    projectRoot: workspace.rootPath,
    canvasId: null,
    scope: { kind: "project" },
    phase: "completed",
    stepCount: 1,
    stepLimit: 20,
    currentRef: "T-001#B-001",
    currentExecutor: "fake-codex",
    elapsedMs: 1250,
    latestOutputSummary: "persisted output",
    latestRecordId: "T-001#B-001::RUN-001",
    latestRecordPath: join(
      workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-001",
      "metadata.json"
    ),
    statePath: join(runRoot, "state.json"),
    eventLogPath: join(runRoot, "events.ndjson"),
    options: { tmuxEnabled: false },
    error: null,
    startedAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:01.250Z",
    ...patch
  } satisfies Omit<DesktopAutoRunState, "explanation">;
  return {
    ...state,
    explanation: {
      phase: state.phase,
      currentRef: state.currentRef,
      currentExecutor: state.currentExecutor,
      latestRecordId: state.latestRecordId,
      latestRecordPath: state.latestRecordPath,
      latestOutputSummary: state.latestOutputSummary,
      error: state.error,
      nextAction: {
        kind: "review_status",
        message: "Review the final status and latest run record.",
        command: null,
        targetPath: null,
        ref: state.currentRef
      }
    }
  };
}

async function writePersistedAutoRunState(state: DesktopAutoRunState): Promise<void> {
  await mkdir(dirname(state.statePath), { recursive: true });
  await writeFile(state.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function createTestWorkspaceInHome(
  home: string,
  manifest: PlanPackageManifest
): Promise<{
  root: string;
  init: Awaited<ReturnType<typeof initWorkspace>>;
}> {
  const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
  process.env.PLANWEAVE_HOME = home;
  const init = await initWorkspace({ projectRoot: root });
  await writeJsonFile(init.workspace.manifestFile, manifest);
  await writePromptFiles(init.workspace.packageDir, manifest);
  return { root, init };
}

function desktopRunNumber(runId: string): number {
  const match = /^DESKTOP-RUN-(\d+)$/.exec(runId);
  expect(match).not.toBeNull();
  return Number.parseInt(match![1], 10);
}

function globalAutoRunIdsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.planweaveHome, "desktop", "auto-run-ids");
}

function autoRunIdReservationIndexPath(workspace: ProjectWorkspace): string {
  return join(globalAutoRunIdsRoot(workspace), "index.json");
}

async function waitForRun(
  runId: string,
  predicate: (state: Awaited<ReturnType<typeof getAutoRunState>>) => boolean
) {
  let state = await getAutoRunState(runId);
  for (let attempt = 0; attempt < 500 && !predicate(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await getAutoRunState(runId);
  }
  return state;
}

describe("desktop auto run persistence", () => {
  it("migrates legacy Auto Run directories into global run id reservations before allocating", async () => {
    const manifest = manifestTestBuilder().build();
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const current = await createTestWorkspaceInHome(home, manifest);
    const historical = await createTestWorkspaceInHome(home, manifest);
    const canvas = await createTaskCanvas(historical.root, { name: "Historical canvas" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(historical.root, canvas.canvasId);
    await writePersistedAutoRunState(
      persistedAutoRunState(current.init.workspace, { runId: "DESKTOP-RUN-0003" })
    );
    await writePersistedAutoRunState(
      persistedAutoRunState(canvasWorkspace, {
        runId: "DESKTOP-RUN-0007",
        canvasId: canvas.canvasId
      })
    );

    await expect(nextPersistedAutoRunId(current.init.workspace)).resolves.toBe("DESKTOP-RUN-0008");

    const reservationsRoot = globalAutoRunIdsRoot(current.init.workspace);
    await expect(
      readJsonFile(autoRunIdReservationIndexPath(current.init.workspace))
    ).resolves.toMatchObject({
      version: 1,
      highestRunId: "DESKTOP-RUN-0008",
      migratedAt: expect.any(String)
    });
    await expect(
      mkdir(join(reservationsRoot, "DESKTOP-RUN-0003"), { recursive: false })
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      mkdir(join(reservationsRoot, "DESKTOP-RUN-0007"), { recursive: false })
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      mkdir(join(reservationsRoot, "DESKTOP-RUN-0008"), { recursive: false })
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("does not scan the projects root after the Auto Run id reservation index exists", async () => {
    const manifest = manifestTestBuilder().build();
    const { init } = await createTestWorkspace(manifest);
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, { runId: "DESKTOP-RUN-0002" })
    );
    await expect(nextPersistedAutoRunId(init.workspace)).resolves.toBe("DESKTOP-RUN-0003");

    fsObservations.readdirPaths = [];

    await expect(nextPersistedAutoRunId(init.workspace)).resolves.toBe("DESKTOP-RUN-0004");
    expect(fsObservations.readdirPaths).not.toContain(
      join(init.workspace.planweaveHome, "projects")
    );
  });

  it("allocates after the highest existing global Auto Run id reservation directory", async () => {
    const manifest = manifestTestBuilder().build();
    const { init } = await createTestWorkspace(manifest);
    await mkdir(join(globalAutoRunIdsRoot(init.workspace), "DESKTOP-RUN-0042"), {
      recursive: true
    });

    await expect(nextPersistedAutoRunId(init.workspace)).resolves.toBe("DESKTOP-RUN-0043");
  });

  it("keeps in-memory Auto Run id reservations ahead of persisted allocation", async () => {
    const manifest = manifestTestBuilder().build();
    const { init } = await createTestWorkspace(manifest);

    await expect(
      nextPersistedAutoRunId(init.workspace, {
        isReserved: (runId) => runId === "DESKTOP-RUN-0001"
      })
    ).resolves.toBe("DESKTOP-RUN-0002");
  });

  it("keeps incrementing when the current workspace run directory already exists after reservation", async () => {
    const manifest = manifestTestBuilder().build();
    const { init } = await createTestWorkspace(manifest);
    await mkdir(join(init.workspace.resultsDir, "auto-runs", "DESKTOP-RUN-0001"), {
      recursive: true
    });
    await writeJsonFile(autoRunIdReservationIndexPath(init.workspace), {
      version: 1,
      highestRunId: null,
      migratedAt: "2026-05-23T00:00:00.000Z"
    });

    await expect(nextPersistedAutoRunId(init.workspace)).resolves.toBe("DESKTOP-RUN-0002");
    await expect(
      mkdir(join(globalAutoRunIdsRoot(init.workspace), "DESKTOP-RUN-0001"), { recursive: false })
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      mkdir(join(globalAutoRunIdsRoot(init.workspace), "DESKTOP-RUN-0002"), { recursive: false })
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("repairs a corrupt Auto Run id reservation index from legacy runs and reservation directories", async () => {
    const manifest = manifestTestBuilder().build();
    const { init } = await createTestWorkspace(manifest);
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, { runId: "DESKTOP-RUN-0005" })
    );
    await mkdir(globalAutoRunIdsRoot(init.workspace), { recursive: true });
    await writeFile(autoRunIdReservationIndexPath(init.workspace), "{", "utf8");

    await expect(nextPersistedAutoRunId(init.workspace)).resolves.toBe("DESKTOP-RUN-0006");
    await expect(
      readJsonFile(autoRunIdReservationIndexPath(init.workspace))
    ).resolves.toMatchObject({
      version: 1,
      highestRunId: "DESKTOP-RUN-0006",
      migratedAt: expect.any(String)
    });
  });

  it("allocates desktop run IDs after existing persisted Auto Run directories", async () => {
    const manifest = manifestTestBuilder().build();
    const { root, init } = await createTestWorkspace(manifest);
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, { runId: "DESKTOP-RUN-0007" })
    );

    const started = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(started.runId);

    expect(desktopRunNumber(started.runId)).toBeGreaterThanOrEqual(8);
  });

  it("allocates distinct desktop run IDs for concurrent starts", async () => {
    const manifest = manifestTestBuilder().build();
    const { root } = await createTestWorkspace(manifest);

    const [first, second] = await Promise.all([
      startAutoRun(root, null, { kind: "project" }, 0, noTmux),
      startAutoRun(root, null, { kind: "project" }, 0, noTmux)
    ]);
    startedRunIds.add(first.runId);
    startedRunIds.add(second.runId);

    expect(first.runId).not.toBe(second.runId);
    expect(first.runId).toMatch(/^DESKTOP-RUN-\d{4,}$/);
    expect(second.runId).toMatch(/^DESKTOP-RUN-\d{4,}$/);
  });

  it("allocates globally distinct desktop run IDs across project canvas workspaces", async () => {
    const manifest = manifestTestBuilder().build();
    const { root } = await createTestWorkspace(manifest);
    const canvas = await createTaskCanvas(root, { name: "Second canvas" });

    const defaultRun = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    const canvasRun = await startAutoRun(root, canvas.canvasId, { kind: "project" }, 0, noTmux);
    startedRunIds.add(defaultRun.runId);
    startedRunIds.add(canvasRun.runId);

    expect(defaultRun.runId).not.toBe(canvasRun.runId);
    await expect(getAutoRunState(defaultRun.runId)).resolves.toMatchObject({
      runId: defaultRun.runId,
      projectRoot: root,
      canvasId: null
    });
    await expect(getAutoRunState(canvasRun.runId)).resolves.toMatchObject({
      runId: canvasRun.runId,
      projectRoot: root,
      canvasId: canvas.canvasId
    });
  });

  it("allocates desktop run IDs after existing persisted Auto Run directories in other canvases", async () => {
    const manifest = manifestTestBuilder().build();
    const { root } = await createTestWorkspace(manifest);
    const canvas = await createTaskCanvas(root, { name: "Second canvas" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    await writePersistedAutoRunState(
      persistedAutoRunState(canvasWorkspace, {
        runId: "DESKTOP-RUN-0007",
        canvasId: canvas.canvasId
      })
    );

    const started = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(started.runId);

    expect(desktopRunNumber(started.runId)).toBeGreaterThanOrEqual(8);
  });

  it("allocates desktop run IDs after existing persisted Auto Run directories in custom canvas results dirs", async () => {
    const manifest = manifestTestBuilder().build();
    const { root, init } = await createTestWorkspace(manifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default" }),
        {
          id: "manual-canvas",
          type: "canvas",
          title: "Manual canvas",
          packageDir: "manual-canvas/package",
          stateFile: "manual-canvas/state.json",
          resultsDir: "manual-canvas/results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, "manual-canvas");
    await writePersistedAutoRunState(
      persistedAutoRunState(canvasWorkspace, {
        runId: "DESKTOP-RUN-0007",
        canvasId: "manual-canvas"
      })
    );

    const started = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(started.runId);

    expect(desktopRunNumber(started.runId)).toBeGreaterThanOrEqual(8);
  });

  it("allocates desktop run IDs when an unrelated historical project has corrupt metadata", async () => {
    const manifest = manifestTestBuilder().build();
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const current = await createTestWorkspaceInHome(home, manifest);
    const corruptProjectRoot = join(home, "projects", "corrupt-project");
    await mkdir(corruptProjectRoot, { recursive: true });
    await writeFile(join(corruptProjectRoot, "project.json"), "{", "utf8");

    const started = await startAutoRun(current.root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(started.runId);

    await expect(getAutoRunState(started.runId)).resolves.toMatchObject({
      runId: started.runId,
      projectRoot: current.root
    });
  });

  it("uses historical project graph canvas results dirs even when project metadata is corrupt", async () => {
    const manifest = manifestTestBuilder().build();
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const current = await createTestWorkspaceInHome(home, manifest);
    const historicalWorkspace = await createTestWorkspaceInHome(home, manifest);
    await writeProjectGraph(historicalWorkspace.init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default" }),
        {
          id: "manual-canvas",
          type: "canvas",
          title: "Manual canvas",
          packageDir: "manual-canvas/package",
          stateFile: "manual-canvas/state.json",
          resultsDir: "manual-canvas/results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(
      historicalWorkspace.root,
      "manual-canvas"
    );
    await writePersistedAutoRunState(
      persistedAutoRunState(canvasWorkspace, {
        runId: "DESKTOP-RUN-0007",
        canvasId: "manual-canvas"
      })
    );
    await writeFile(historicalWorkspace.init.workspace.projectFile, "{", "utf8");

    const started = await startAutoRun(current.root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(started.runId);

    expect(desktopRunNumber(started.runId)).toBeGreaterThanOrEqual(8);
  });

  it("allocates globally distinct desktop run IDs across projects in the same PlanWeave home", async () => {
    const manifest = manifestTestBuilder().build();
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const firstWorkspace = await createTestWorkspaceInHome(home, manifest);
    const secondWorkspace = await createTestWorkspaceInHome(home, manifest);

    const [firstRun, secondRun] = await Promise.all([
      startAutoRun(firstWorkspace.root, null, { kind: "project" }, 0, noTmux),
      startAutoRun(secondWorkspace.root, null, { kind: "project" }, 0, noTmux)
    ]);
    startedRunIds.add(firstRun.runId);
    startedRunIds.add(secondRun.runId);

    expect(firstRun.runId).not.toBe(secondRun.runId);
    await expect(getAutoRunState(firstRun.runId)).resolves.toMatchObject({
      runId: firstRun.runId,
      projectRoot: firstWorkspace.root,
      canvasId: null
    });
    await expect(getAutoRunState(secondRun.runId)).resolves.toMatchObject({
      runId: secondRun.runId,
      projectRoot: secondWorkspace.root,
      canvasId: null
    });
  });

  it("recovers the latest persisted Auto Run summary without reporting interrupted runs as active", async () => {
    const manifest = manifestTestBuilder().build();
    const { root, init } = await createTestWorkspace(manifest);
    const interrupted = persistedAutoRunState(init.workspace, {
      runId: "DESKTOP-RUN-0003",
      phase: "running",
      error: null,
      updatedAt: "2026-05-23T00:00:01.250Z"
    });
    await writePersistedAutoRunState(interrupted);

    const summary = await getLatestAutoRunSummary(root, null);

    expect(summary).toMatchObject({
      runId: "DESKTOP-RUN-0003",
      phase: "failed",
      currentRef: "T-001#B-001",
      currentExecutor: "fake-codex",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: interrupted.latestRecordPath,
      statePath: interrupted.statePath,
      eventLogPath: interrupted.eventLogPath,
      elapsedMs: 1250,
      error: expect.stringContaining("interrupted while running"),
      explanation: {
        phase: "failed",
        error: expect.stringContaining("interrupted while running"),
        latestRecordPath: interrupted.latestRecordPath,
        nextAction: {
          kind: "inspect_record",
          message: "Inspect the latest run record, then resolve the blocker before retrying.",
          targetPath: interrupted.latestRecordPath
        }
      }
    });
  });

  it("rehydrates persisted paused Auto Run summaries so they can resume", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("slow-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => setTimeout(() => console.log('rehydrated ' + input.split('\\n')[0]), 5_000));"
        ]
      })
      .withDefaultExecutor("slow-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    const paused = persistedAutoRunState(init.workspace, {
      runId: "DESKTOP-RUN-9104",
      phase: "paused",
      error: "Step limit reached.",
      updatedAt: "2026-05-23T00:00:04.000Z"
    });
    await writePersistedAutoRunState(paused);

    const summary = await getLatestAutoRunSummary(root, null);

    expect(summary).toMatchObject({
      runId: "DESKTOP-RUN-9104",
      phase: "paused",
      explanation: {
        phase: "paused",
        nextAction: {
          kind: "resume"
        }
      }
    });
    await expect(resumeAutoRun(paused.runId)).resolves.toMatchObject({
      runId: paused.runId,
      phase: "running"
    });
    startedRunIds.add(paused.runId);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const log = await readFile(paused.eventLogPath, "utf8").catch(() => "");
      if (log.includes('"type":"step_start"')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(shutdownDesktopAutoRuns("rehydrated run teardown")).resolves.toBeUndefined();
    const state = await readState(init.workspace.stateFile);
    expect(state.blocks["T-001#B-001"]?.status).toBe("ready");
  });

  it("keeps stopped runs readable from disk after releasing terminal state", async () => {
    const manifest = manifestTestBuilder().build();
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 0, noTmux);
    startedRunIds.add(started.runId);
    expect(await waitForRun(started.runId, (state) => state.phase === "paused")).toMatchObject({
      runId: started.runId,
      phase: "paused"
    });

    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({
      runId: started.runId,
      phase: "stopped"
    });
    await expect(getAutoRunState(started.runId)).rejects.toThrow(
      `Auto Run '${started.runId}' does not exist.`
    );
    await expect(getLatestAutoRunSummary(root, null)).resolves.toMatchObject({
      runId: started.runId,
      phase: "stopped"
    });
    await expect(listAutoRunEvents(root, null, started.runId)).resolves.toMatchObject({
      runId: started.runId,
      diagnostics: [],
      events: expect.arrayContaining([
        expect.objectContaining({ type: "run_stopped", phase: "stopped" })
      ])
    });
  });

  it("does not silently overwrite an in-memory run when rehydrating a duplicated persisted run ID", async () => {
    const manifest = manifestTestBuilder().build();
    const { root, init } = await createTestWorkspace(manifest);
    const canvas = await createTaskCanvas(root, { name: "Second canvas" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-9001",
        phase: "paused",
        updatedAt: "2026-05-23T00:00:04.000Z"
      })
    );
    await writePersistedAutoRunState(
      persistedAutoRunState(canvasWorkspace, {
        runId: "DESKTOP-RUN-9001",
        canvasId: canvas.canvasId,
        phase: "paused",
        updatedAt: "2026-05-23T00:00:05.000Z"
      })
    );

    await expect(getLatestAutoRunSummary(root, null)).resolves.toMatchObject({
      runId: "DESKTOP-RUN-9001",
      canvasId: null
    });
    await expect(getLatestAutoRunSummary(root, canvas.canvasId)).rejects.toThrow(
      "already belongs to project"
    );
    await expect(getAutoRunState("DESKTOP-RUN-9001")).resolves.toMatchObject({
      runId: "DESKTOP-RUN-9001",
      canvasId: null
    });
  });

  it("rehydrates persisted manual Auto Run summaries as continuable manual-result sessions", async () => {
    const manifest = manifestTestBuilder().build();
    const { root, init } = await createTestWorkspace(manifest);
    const manual = {
      ...persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-9105",
        phase: "manual",
        currentExecutor: "manual",
        latestOutputSummary: "Manual result required.",
        error: "Manual result required.",
        updatedAt: "2026-05-23T00:00:05.000Z"
      }),
      explanation: {
        phase: "manual",
        currentRef: "T-001#B-001",
        currentExecutor: "manual",
        latestRecordId: "T-001#B-001::RUN-001",
        latestRecordPath: null,
        latestOutputSummary: "Manual result required.",
        error: "Manual result required.",
        nextAction: {
          kind: "submit_manual_result",
          message: "Submit a manual result file for the current block.",
          command: "planweave submit T-001#B-001 --report <path>",
          targetPath: null,
          ref: "T-001#B-001"
        }
      }
    } satisfies DesktopAutoRunState;
    await writePersistedAutoRunState(manual);

    const summary = await getLatestAutoRunSummary(root, null);

    expect(summary).toMatchObject({
      runId: "DESKTOP-RUN-9105",
      phase: "manual",
      error: "Manual result required.",
      explanation: {
        phase: "manual",
        nextAction: {
          kind: "submit_manual_result",
          command: "planweave submit T-001#B-001 --report <path>",
          ref: "T-001#B-001"
        }
      }
    });
    await expect(getAutoRunState(manual.runId)).resolves.toMatchObject({
      runId: manual.runId,
      phase: "manual"
    });
  });

  it("skips corrupt persisted Auto Run states while recovering the latest valid summary", async () => {
    const manifest = manifestTestBuilder().build();
    const { root, init } = await createTestWorkspace(manifest);
    const valid = persistedAutoRunState(init.workspace, {
      runId: "DESKTOP-RUN-0002",
      phase: "completed",
      updatedAt: "2026-05-23T00:00:02.000Z"
    });
    const corrupt = persistedAutoRunState(init.workspace, {
      runId: "DESKTOP-RUN-0003",
      updatedAt: "2026-05-23T00:00:03.000Z"
    });
    await writePersistedAutoRunState(valid);
    await mkdir(dirname(corrupt.statePath), { recursive: true });
    await writeFile(corrupt.statePath, "{", "utf8");

    await expect(getLatestAutoRunSummary(root, null)).resolves.toMatchObject({
      runId: "DESKTOP-RUN-0002",
      phase: "completed"
    });
    await expect(readLatestPersistedAutoRunState(init.workspace)).resolves.toMatchObject({
      state: expect.objectContaining({ runId: "DESKTOP-RUN-0002" }),
      diagnostics: [
        expect.objectContaining({
          code: "auto_run_state_invalid_json",
          path: corrupt.statePath
        })
      ]
    });
    await expect(getLatestAutoRunSummaryWithDiagnostics(root, null)).resolves.toMatchObject({
      state: expect.objectContaining({ runId: "DESKTOP-RUN-0002" }),
      diagnostics: [
        expect.objectContaining({
          code: "auto_run_state_invalid_json",
          path: corrupt.statePath
        })
      ]
    });
  });

  it("reports diagnostics when every persisted Auto Run summary state is corrupt", async () => {
    const manifest = manifestTestBuilder().build();
    const { root, init } = await createTestWorkspace(manifest);
    const corrupt = persistedAutoRunState(init.workspace, { runId: "DESKTOP-RUN-0001" });
    await mkdir(dirname(corrupt.statePath), { recursive: true });
    await writeFile(corrupt.statePath, "{", "utf8");

    await expect(getLatestAutoRunSummaryWithDiagnostics(root, null)).resolves.toMatchObject({
      state: null,
      diagnostics: [
        expect.objectContaining({
          code: "auto_run_state_invalid_json",
          path: corrupt.statePath
        })
      ]
    });
  });

  it("keeps corrupt latest diagnostics after rehydrating a persisted manual run", async () => {
    const manifest = manifestTestBuilder().build();
    const { root, init } = await createTestWorkspace(manifest);
    const manual = persistedAutoRunState(init.workspace, {
      runId: "DESKTOP-RUN-9202",
      phase: "manual",
      error: "Manual result required.",
      updatedAt: "2026-05-23T00:00:02.000Z"
    });
    const corrupt = persistedAutoRunState(init.workspace, {
      runId: "DESKTOP-RUN-9203",
      updatedAt: "2026-05-23T00:00:03.000Z"
    });
    await writePersistedAutoRunState(manual);
    await mkdir(dirname(corrupt.statePath), { recursive: true });
    await writeFile(corrupt.statePath, "{", "utf8");

    await expect(getLatestAutoRunSummaryWithDiagnostics(root, null)).resolves.toMatchObject({
      state: expect.objectContaining({ runId: "DESKTOP-RUN-9202", phase: "manual" }),
      diagnostics: [
        expect.objectContaining({
          code: "auto_run_state_invalid_json",
          path: corrupt.statePath
        })
      ]
    });
    await expect(getAutoRunState(manual.runId)).resolves.toMatchObject({
      runId: manual.runId,
      phase: "manual"
    });
    await expect(getLatestAutoRunSummaryWithDiagnostics(root, null)).resolves.toMatchObject({
      state: expect.objectContaining({ runId: "DESKTOP-RUN-9202", phase: "manual" }),
      diagnostics: [
        expect.objectContaining({
          code: "auto_run_state_invalid_json",
          path: corrupt.statePath
        })
      ]
    });
  });

  it("keeps updatedAt ordering while omitting older corrupt persisted Auto Run diagnostics", async () => {
    const manifest = manifestTestBuilder().build();
    const { root, init } = await createTestWorkspace(manifest);
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-0025",
        updatedAt: "2026-05-23T00:00:25.000Z"
      })
    );
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-0020",
        updatedAt: "2026-05-23T00:00:30.000Z"
      })
    );
    const olderCorrupt = persistedAutoRunState(init.workspace, { runId: "DESKTOP-RUN-0019" });
    await mkdir(dirname(olderCorrupt.statePath), { recursive: true });
    await writeFile(olderCorrupt.statePath, "{", "utf8");

    await expect(getLatestAutoRunSummary(root, null)).resolves.toMatchObject({
      runId: "DESKTOP-RUN-0020"
    });
    await expect(readLatestPersistedAutoRunState(init.workspace)).resolves.toMatchObject({
      state: expect.objectContaining({ runId: "DESKTOP-RUN-0020" }),
      diagnostics: []
    });
  });

  it("writes a latest summary pointer when persisting Auto Run state", async () => {
    const manifest = manifestTestBuilder().build();
    const { init } = await createTestWorkspace(manifest);
    const state = persistedAutoRunState(init.workspace, {
      runId: "DESKTOP-RUN-0002",
      updatedAt: "2026-05-23T00:00:02.000Z"
    });

    await writeRepositoryPersistedAutoRunState(state);

    await expect(
      readJsonFile(join(init.workspace.resultsDir, "auto-runs", "latest-state.json"))
    ).resolves.toMatchObject({
      version: 1,
      selectedRunId: "DESKTOP-RUN-0002",
      selectedUpdatedAt: "2026-05-23T00:00:02.000Z",
      highestRunId: "DESKTOP-RUN-0002",
      diagnostics: []
    });
  });

  it("migrates legacy Auto Run histories to a latest pointer without losing newer corrupt diagnostics", async () => {
    const manifest = manifestTestBuilder().build();
    const { root, init } = await createTestWorkspace(manifest);
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-0025",
        updatedAt: "2026-05-23T00:00:25.000Z"
      })
    );
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-0020",
        updatedAt: "2026-05-23T00:00:30.000Z"
      })
    );
    const corrupt = persistedAutoRunState(init.workspace, { runId: "DESKTOP-RUN-0026" });
    await mkdir(dirname(corrupt.statePath), { recursive: true });
    await writeFile(corrupt.statePath, "{", "utf8");

    await expect(getLatestAutoRunSummaryWithDiagnostics(root, null)).resolves.toMatchObject({
      state: expect.objectContaining({ runId: "DESKTOP-RUN-0020" }),
      diagnostics: [
        expect.objectContaining({
          code: "auto_run_state_invalid_json",
          path: corrupt.statePath
        })
      ]
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "auto-runs", "latest-state.json"))
    ).resolves.toMatchObject({
      selectedRunId: "DESKTOP-RUN-0020",
      highestRunId: "DESKTOP-RUN-0026",
      diagnostics: [
        expect.objectContaining({
          runId: "DESKTOP-RUN-0026",
          diagnostic: expect.objectContaining({ code: "auto_run_state_invalid_json" })
        })
      ]
    });
    await expect(getLatestAutoRunSummaryWithDiagnostics(root, null)).resolves.toMatchObject({
      state: expect.objectContaining({ runId: "DESKTOP-RUN-0020" }),
      diagnostics: [
        expect.objectContaining({
          code: "auto_run_state_invalid_json",
          path: corrupt.statePath
        })
      ]
    });
  });

  it("does not let a filtered latest read overwrite the workspace latest pointer", async () => {
    const manifest = manifestTestBuilder().build();
    const { init } = await createTestWorkspace(manifest);
    await writePersistedAutoRunState(
      persistedAutoRunState(init.workspace, {
        runId: "DESKTOP-RUN-0031",
        updatedAt: "2026-05-23T00:00:31.000Z"
      })
    );

    await expect(
      readLatestPersistedAutoRunState(init.workspace, { matches: () => false })
    ).resolves.toMatchObject({
      state: null,
      diagnostics: []
    });
    await expect(readLatestPersistedAutoRunState(init.workspace)).resolves.toMatchObject({
      state: expect.objectContaining({ runId: "DESKTOP-RUN-0031" }),
      diagnostics: []
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "auto-runs", "latest-state.json"))
    ).resolves.toMatchObject({
      selectedRunId: "DESKTOP-RUN-0031",
      highestRunId: "DESKTOP-RUN-0031"
    });
  });

  it("repairs the latest pointer when its selected state becomes corrupt during a filtered read", async () => {
    const manifest = manifestTestBuilder().build();
    const { init } = await createTestWorkspace(manifest);
    const older = persistedAutoRunState(init.workspace, {
      runId: "DESKTOP-RUN-0040",
      updatedAt: "2026-05-23T00:00:40.000Z"
    });
    const latest = persistedAutoRunState(init.workspace, {
      runId: "DESKTOP-RUN-0042",
      updatedAt: "2026-05-23T00:00:42.000Z"
    });
    await writeRepositoryPersistedAutoRunState(older);
    await writeRepositoryPersistedAutoRunState(latest);
    await writeFile(latest.statePath, "{", "utf8");

    const matchesWorkspace = (state: DesktopAutoRunState) =>
      state.projectRoot === init.workspace.rootPath && state.canvasId === null;

    await expect(
      readLatestPersistedAutoRunState(init.workspace, { matches: matchesWorkspace })
    ).resolves.toMatchObject({
      state: expect.objectContaining({ runId: "DESKTOP-RUN-0040" }),
      diagnostics: [
        expect.objectContaining({
          code: "auto_run_state_invalid_json",
          path: latest.statePath
        })
      ]
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "auto-runs", "latest-state.json"))
    ).resolves.toMatchObject({
      selectedRunId: "DESKTOP-RUN-0040",
      highestRunId: "DESKTOP-RUN-0042",
      diagnostics: [
        expect.objectContaining({
          runId: "DESKTOP-RUN-0042",
          diagnostic: expect.objectContaining({ code: "auto_run_state_invalid_json" })
        })
      ]
    });
    const middleCorrupt = persistedAutoRunState(init.workspace, { runId: "DESKTOP-RUN-0041" });
    await mkdir(dirname(middleCorrupt.statePath), { recursive: true });
    await writeFile(middleCorrupt.statePath, "{", "utf8");

    const secondRead = await readLatestPersistedAutoRunState(init.workspace, {
      matches: matchesWorkspace
    });
    expect(secondRead.state).toMatchObject({ runId: "DESKTOP-RUN-0040" });
    expect(secondRead.diagnostics).toEqual([
      expect.objectContaining({
        code: "auto_run_state_invalid_json",
        path: latest.statePath
      })
    ]);
  });
});
