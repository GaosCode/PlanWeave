import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAutoRunState,
  getLatestAutoRunSummary,
  pauseAutoRun,
  resumeAutoRun,
  startAutoRun,
  stopAutoRun
} from "../desktop/index.js";
import { isTmuxAvailable } from "../autoRun/tmuxExecutor.js";
import { readState } from "../state.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

async function waitForRun(runId: string, predicate: (state: Awaited<ReturnType<typeof getAutoRunState>>) => boolean) {
  let state = await getAutoRunState(runId);
  for (let attempt = 0; attempt < 200 && !predicate(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await getAutoRunState(runId);
  }
  return state;
}

describe("desktop auto run API", () => {
  it("starts, pauses, resumes, stops, and summarizes project-level Auto Run", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('desktop auto run ' + input.split('\\n')[0]); });"
        ]
      }
    };
    manifest.execution.defaultExecutor = "fake-codex";
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 1);
    expect(started.phase).toBe("running");

    const current = await waitForRun(started.runId, (nextState) => nextState.phase !== "running");

    expect(current).toMatchObject({
      phase: "paused",
      stepCount: 1,
      currentExecutor: "fake-codex",
      error: "Step limit reached."
    });
    expect(current.startedAt).toEqual(expect.any(String));
    expect(current.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(current.latestOutputSummary).toContain("desktop auto run");
    expect(current.latestRecordId).toBe("T-001#B-001::RUN-001");
    expect(current.latestRecordPath).toContain("metadata.json");
    expect(current.statePath).toContain("auto-runs");
    expect(current.eventLogPath).toContain("events.ndjson");
    await expect(readFile(current.statePath, "utf8")).resolves.toContain('"phase": "paused"');
    await expect(readFile(current.eventLogPath, "utf8")).resolves.toContain('"type":"step_limit_reached"');
    await expect(getLatestAutoRunSummary(root, null)).resolves.toMatchObject({ runId: started.runId });

    await expect(resumeAutoRun(started.runId)).resolves.toMatchObject({ phase: "running" });
    expect(["pausing", "paused"]).toContain((await pauseAutoRun(started.runId)).phase);
    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({ phase: "stopped" });
  });

  it("finishes the in-flight block before pausing and resumes the same run", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "slow-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { setTimeout(() => console.log('slow auto run ' + input.split('\\n')[0]), 120); });"
        ]
      }
    };
    manifest.execution.defaultExecutor = "slow-codex";
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 2);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const log = await readFile(started.eventLogPath, "utf8").catch(() => "");
      if (log.includes('"type":"step_start"')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await expect(pauseAutoRun(started.runId)).resolves.toMatchObject({ phase: "pausing" });

    const paused = await waitForRun(started.runId, (state) => state.phase === "paused");
    expect(paused).toMatchObject({
      phase: "paused",
      stepCount: 1,
      currentRef: "T-001#B-001",
      currentExecutor: "slow-codex"
    });
    await expect(readFile(paused.eventLogPath, "utf8")).resolves.toContain('"pausedAfterStep":true');

    await expect(resumeAutoRun(started.runId)).resolves.toMatchObject({ phase: "running" });
    const resumed = await waitForRun(started.runId, (state) => state.phase === "paused" && state.stepCount === 2);
    expect(resumed).toMatchObject({
      phase: "paused",
      stepCount: 2,
      error: "Step limit reached."
    });
  });

  it("stops an in-flight tmux-backed Auto Run without replacing the stopped phase with failed", async () => {
    if (!(await isTmuxAvailable())) {
      return;
    }
    const manifest = basicManifest() as any;
    manifest.executors = {
      "long-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { setInterval(() => process.stdout.write('still running\\n'), 100); });"
        ]
      }
    };
    manifest.execution.defaultExecutor = "long-codex";
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 2);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const log = await readFile(started.eventLogPath, "utf8").catch(() => "");
      if (log.includes('"type":"step_start"')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({ phase: "stopped" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(getAutoRunState(started.runId)).resolves.toMatchObject({ phase: "stopped" });
    await expect(readFile(started.eventLogPath, "utf8")).resolves.toContain('"type":"run_stopped"');
  });

  it("runs selected task and selected block Auto Run through the Task Manager claim order", async () => {
    const manifest = basicManifest({ includeSecondTask: true }) as any;
    manifest.executors = {
      "fake-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('scoped auto run ' + input.split('\\n')[0]); });"
        ]
      }
    };
    manifest.execution.defaultExecutor = "fake-codex";
    const { root } = await createTestWorkspace(manifest);

    const taskRun = await startAutoRun(root, null, { kind: "task", taskId: "T-002" }, 1);
    const taskState = await waitForRun(taskRun.runId, (state) => state.phase !== "running");
    expect(taskState).toMatchObject({
      scope: { kind: "task", taskId: "T-002" },
      phase: "paused",
      currentRef: "T-002#B-001",
      currentExecutor: "fake-codex",
      stepCount: 1
    });

    const blockRun = await startAutoRun(root, null, { kind: "block", blockRef: "T-001#B-001" }, 1);
    const blockState = await waitForRun(blockRun.runId, (state) => state.phase !== "running");
    expect(blockState).toMatchObject({
      scope: { kind: "block", blockRef: "T-001#B-001" },
      phase: "paused",
      currentRef: "T-001#B-001",
      currentExecutor: "fake-codex",
      stepCount: 1
    });
  });

  it("uses manifest parallel mode for project-level Auto Run", async () => {
    const manifest = basicManifest({ includeSecondTask: true, maxConcurrent: 2, parallel: true }) as any;
    manifest.executors = {
      "fake-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('parallel auto run ' + input.split('\\n')[0]); });"
        ]
      }
    };
    manifest.execution.defaultExecutor = "fake-codex";
    const { root } = await createTestWorkspace(manifest);

    const run = await startAutoRun(root, null, { kind: "project" }, 1);
    const state = await waitForRun(run.runId, (nextState) => nextState.phase !== "running");

    expect(state).toMatchObject({
      phase: "paused",
      currentRef: "T-001#B-001",
      currentExecutor: "fake-codex",
      latestOutputSummary: "2 block(s) submitted.",
      stepCount: 1
    });
  });

  it("blocks the desktop run when review warnings remain after no claimable work", async () => {
    const manifest = basicManifest({ reviewMaxFeedbackCycles: 0 }) as any;
    manifest.executors = {
      "fake-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('warning test ' + input.split('\\n')[0]); });"
        ]
      },
      "needs-review": {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log(JSON.stringify({ reviewBlockRef: 'T-001#R-001', taskId: 'T-001', verdict: 'needs_changes', content: 'changes required' })); });"
        ]
      }
    };
    manifest.execution.defaultExecutor = "fake-codex";
    const task = manifest.nodes.find((node: any) => node.id === "T-001");
    for (const block of task.blocks) {
      block.executor = block.type === "review" ? "needs-review" : "fake-codex";
    }
    const { root } = await createTestWorkspace(manifest);

    const run = await startAutoRun(root, null, { kind: "project" }, 5);
    const state = await waitForRun(run.runId, (nextState) => nextState.phase !== "running");

    expect(state).toMatchObject({
      phase: "blocked",
      error: expect.stringContaining("reached max feedback cycles")
    });

    const retried = await startAutoRun(root, null, { kind: "project" }, 1);
    const retryState = await waitForRun(retried.runId, (nextState) => nextState.phase !== "running");

    expect(retryState).toMatchObject({
      phase: "paused",
      currentRef: "T-001#R-001",
      currentExecutor: "needs-review",
      stepCount: 1,
      error: "Step limit reached."
    });
    await expect(readFile(retryState.eventLogPath, "utf8")).resolves.toContain('"resetMaxCycleReviewRefs":["T-001#R-001"]');
  });

  it("starts a fresh feedback cycle when retrying a max-cycle review", async () => {
    const manifest = basicManifest({ reviewMaxFeedbackCycles: 1 }) as any;
    manifest.executors = {
      "fake-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('retry feedback ' + input.split('\\n')[0]); });"
        ]
      },
      "needs-review": {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log(JSON.stringify({ reviewBlockRef: 'T-001#R-001', taskId: 'T-001', verdict: 'needs_changes', content: 'changes required' })); });"
        ]
      }
    };
    manifest.execution.defaultExecutor = "fake-codex";
    const task = manifest.nodes.find((node: any) => node.id === "T-001");
    for (const block of task.blocks) {
      block.executor = block.type === "review" ? "needs-review" : "fake-codex";
    }
    const { root, init } = await createTestWorkspace(manifest);

    const firstRun = await startAutoRun(root, null, { kind: "project" }, 10);
    const firstState = await waitForRun(firstRun.runId, (nextState) => nextState.phase !== "running");

    expect(firstState).toMatchObject({
      phase: "blocked",
      error: expect.stringContaining("reached max feedback cycles")
    });
    await expect(readState(init.workspace.stateFile)).resolves.toMatchObject({
      feedback: {
        "FE-001": {
          sourceReviewBlockRef: "T-001#R-001",
          status: "resolved"
        }
      }
    });

    const retryRun = await startAutoRun(root, null, { kind: "project" }, 1);
    const retryState = await waitForRun(retryRun.runId, (nextState) => nextState.phase !== "running");

    expect(retryState).toMatchObject({
      phase: "paused",
      currentRef: "T-001#R-001",
      currentExecutor: "needs-review",
      stepCount: 1,
      error: "Step limit reached."
    });
    await expect(readFile(retryState.eventLogPath, "utf8")).resolves.toContain('"resetMaxCycleReviewRefs":["T-001#R-001"]');
    await expect(readState(init.workspace.stateFile)).resolves.toMatchObject({
      feedback: {
        "FE-002": {
          sourceReviewBlockRef: "T-001#R-001",
          status: "open"
        }
      }
    });
  });
});
