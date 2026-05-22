import { afterEach, describe, expect, it } from "vitest";
import {
  getAutoRunState,
  getLatestAutoRunSummary,
  pauseAutoRun,
  resumeAutoRun,
  startAutoRun,
  stopAutoRun
} from "../desktop/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

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

    let current = await getAutoRunState(started.runId);
    for (let attempt = 0; attempt < 20 && current.phase === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      current = await getAutoRunState(started.runId);
    }

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
    await expect(getLatestAutoRunSummary(root, null)).resolves.toMatchObject({ runId: started.runId });

    await expect(resumeAutoRun(started.runId)).resolves.toMatchObject({ phase: "running" });
    await expect(pauseAutoRun(started.runId)).resolves.toMatchObject({ phase: "paused" });
    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({ phase: "stopped" });
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
    let taskState = await getAutoRunState(taskRun.runId);
    for (let attempt = 0; attempt < 20 && taskState.phase === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      taskState = await getAutoRunState(taskRun.runId);
    }
    expect(taskState).toMatchObject({
      scope: { kind: "task", taskId: "T-002" },
      phase: "paused",
      currentRef: "T-002#B-001",
      currentExecutor: "fake-codex",
      stepCount: 1
    });

    const blockRun = await startAutoRun(root, null, { kind: "block", blockRef: "T-001#B-001" }, 1);
    let blockState = await getAutoRunState(blockRun.runId);
    for (let attempt = 0; attempt < 20 && blockState.phase === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      blockState = await getAutoRunState(blockRun.runId);
    }
    expect(blockState).toMatchObject({
      scope: { kind: "block", blockRef: "T-001#B-001" },
      phase: "paused",
      currentRef: "T-001#B-001",
      currentExecutor: "fake-codex",
      stepCount: 1
    });
  });
});
