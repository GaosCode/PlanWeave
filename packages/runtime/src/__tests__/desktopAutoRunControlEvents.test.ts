import { constants } from "node:fs";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAutoRunState,
  getLatestAutoRunSummary,
  pauseAutoRun,
  resumeAutoRun,
  startAutoRun,
  stopAutoRun
} from "../desktop/index.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

const startedRunIds = new Set<string>();
const noTmux = { tmuxEnabled: false } as const;

type AutoRunEventLogEntry = {
  type: string;
  phase: string;
  previousPhase?: string;
  nextPhase?: string;
  stepKind?: string;
  pausedAfterStep?: boolean;
  stoppedPhase?: string;
};

afterEach(async () => {
  await Promise.all([...startedRunIds].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  startedRunIds.clear();
  delete process.env.PLANWEAVE_HOME;
});

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

async function readAutoRunEvents(eventLogPath: string): Promise<AutoRunEventLogEntry[]> {
  const log = await readFile(eventLogPath, "utf8");
  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AutoRunEventLogEntry);
}

async function waitForEvent(
  eventLogPath: string,
  predicate: (event: AutoRunEventLogEntry) => boolean
): Promise<void> {
  let events: AutoRunEventLogEntry[] = [];
  for (let attempt = 0; attempt < 500; attempt += 1) {
    events = await readAutoRunEvents(eventLogPath).catch(() => []);
    if (events.some(predicate)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for Auto Run event. Observed events: ${events.map((event) => event.type).join(", ")}`
  );
}

async function waitForRunRelease(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await getAutoRunState(runId);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for Auto Run '${runId}' to release in-memory state.`);
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(path, constants.F_OK);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for path: ${path}`);
}

describe("desktop auto run control events", () => {
  it("records repeated pause requests without losing the paused final phase", async () => {
    const manifest = basicManifest();
    manifest.executors = {
      "slow-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { setTimeout(() => { console.log('repeat pause auto run ' + input.split('\\n')[0]); }, 160); });"
        ]
      }
    };
    manifest.execution.defaultExecutor = "slow-codex";
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 2, noTmux);
    startedRunIds.add(started.runId);
    await waitForEvent(started.eventLogPath, (event) => event.type === "step_start");

    await expect(pauseAutoRun(started.runId)).resolves.toMatchObject({ phase: "pausing" });
    await expect(pauseAutoRun(started.runId)).resolves.toMatchObject({ phase: "pausing" });

    const paused = await waitForRun(started.runId, (state) => state.phase === "paused");
    expect(paused).toMatchObject({
      phase: "paused",
      stepCount: 1,
      currentRef: "T-001#B-001",
      currentExecutor: "slow-codex"
    });

    const events = await readAutoRunEvents(paused.eventLogPath);
    expect(events.filter((event) => event.type === "pause_requested")).toHaveLength(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "pause_requested",
          previousPhase: "running",
          nextPhase: "pausing"
        }),
        expect.objectContaining({
          type: "step_finish",
          phase: "paused",
          stepKind: "submitted",
          pausedAfterStep: true
        })
      ])
    );
  });

  it("keeps resume while already running on the same run without starting duplicate work", async () => {
    const manifest = basicManifest();
    manifest.executors = {
      "slow-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { setTimeout(() => { console.log('running resume auto run ' + input.split('\\n')[0]); }, 160); });"
        ]
      }
    };
    manifest.execution.defaultExecutor = "slow-codex";
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(started.runId);
    await waitForEvent(started.eventLogPath, (event) => event.type === "step_start");

    const resumed = await resumeAutoRun(started.runId);
    expect(resumed).toMatchObject({
      runId: started.runId,
      phase: "running",
      stepCount: 0
    });
    expect(resumed.startedAt).toBe(started.startedAt);

    const finished = await waitForRun(started.runId, (state) => state.phase === "paused");
    expect(finished).toMatchObject({
      runId: started.runId,
      phase: "paused",
      stepCount: 1,
      error: "Step limit reached."
    });

    const events = await readAutoRunEvents(finished.eventLogPath);
    expect(events.filter((event) => event.type === "run_resumed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "step_start")).toHaveLength(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "step_finish", phase: "running", stepKind: "submitted" })
      ])
    );
  });

  it("records stop after a manual phase as the final auditable transition", async () => {
    const baseManifest = basicManifest();
    const manifest: PlanPackageManifest = {
      ...baseManifest,
      executors: {
        manual: {
          adapter: "manual"
        }
      },
      execution: {
        ...baseManifest.execution,
        defaultExecutor: "manual"
      }
    };
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 5, noTmux);
    startedRunIds.add(started.runId);
    const manual = await waitForRun(started.runId, (state) => state.phase === "manual");
    expect(manual).toMatchObject({
      phase: "manual",
      stepCount: 1,
      currentRef: "T-001#B-001",
      currentExecutor: "manual"
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

    const events = await readAutoRunEvents(manual.eventLogPath);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "step_finish", phase: "manual", stepKind: "manual" }),
        expect.objectContaining({
          type: "run_stopped",
          previousPhase: "manual",
          nextPhase: "stopped"
        })
      ])
    );
  });

  it("keeps stopped final after a non-tmux terminal executor completes later", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "planweave-late-executor-"));
    const markerPath = join(markerDir, "complete.txt");
    const manifest = basicManifest();
    manifest.executors = {
      "slow-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "const fs = require('node:fs'); const marker = process.argv[1]; process.on('exit', () => fs.writeFileSync(marker, 'done')); let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { setTimeout(() => { console.log('late terminal auto run ' + input.split('\\n')[0]); }, 220); });",
          markerPath
        ]
      }
    };
    manifest.execution.defaultExecutor = "slow-codex";
    const workspace = await createTestWorkspace(manifest);

    const started = await startAutoRun(workspace.root, null, { kind: "project" }, 5, noTmux);
    startedRunIds.add(started.runId);
    await waitForEvent(started.eventLogPath, (event) => event.type === "step_start");

    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({
      runId: started.runId,
      phase: "stopped"
    });
    await waitForPath(markerPath);
    await waitForPath(
      join(
        workspace.init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-001",
        "report.md"
      )
    );
    await waitForEvent(started.eventLogPath, (event) => event.type === "stopped_step_ignored");
    await waitForRunRelease(started.runId);
    await expect(getLatestAutoRunSummary(workspace.root, null)).resolves.toMatchObject({
      runId: started.runId,
      phase: "stopped",
      stepCount: 0
    });

    const events = await readAutoRunEvents(started.eventLogPath);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "step_start", phase: "running" }),
        expect.objectContaining({
          type: "run_stopped",
          previousPhase: "running",
          nextPhase: "stopped"
        }),
        expect.objectContaining({
          type: "stopped_step_ignored",
          phase: "stopped",
          stepKind: "submitted",
          stoppedPhase: "stopped"
        })
      ])
    );
    expect(events.filter((event) => event.type === "step_finish")).toHaveLength(0);
  });
});
