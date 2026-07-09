import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allocateRunId } from "../autoRun/executorShared.js";
import { claimBlock, claimNext, getExecutionStatus } from "../taskManager/index.js";
import { loadRuntime } from "../taskManager/runtimeContext.js";
import { updateTaskIndex } from "../taskManager/resultIndex.js";
import type { PlanPackageManifest } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function multiReadyManifest(taskCount: number): PlanPackageManifest {
  return {
    version: "plan-package/v1",
    project: {
      title: "Concurrency Plan",
      description: "Multiple ready implementation blocks."
    },
    execution: {
      parallel: {
        enabled: true,
        maxConcurrent: taskCount
      }
    },
    review: {
      maxFeedbackCycles: 1,
      completionPolicy: "strict"
    },
    nodes: Array.from({ length: taskCount }, (_, index) => {
      const taskId = `T-${String(index + 1).padStart(3, "0")}`;
      return {
        id: taskId,
        type: "task" as const,
        title: `Task ${taskId}`,
        prompt: `nodes/${taskId}/prompt.md`,
        acceptance: ["done"],
        blocks: [
          {
            id: "B-001",
            type: "implementation" as const,
            title: `Implement ${taskId}`,
            prompt: `nodes/${taskId}/blocks/B-001.prompt.md`,
            depends_on: [],
            parallel: { safe: true, locks: [taskId] }
          }
        ]
      };
    }),
    edges: []
  };
}

describe("state concurrency", () => {
  it("serializes concurrent claimNext so only one new claim wins", async () => {
    const { root } = await createTestWorkspace(multiReadyManifest(5));
    const results = await Promise.all(Array.from({ length: 8 }, () => claimNext({ projectRoot: root })));
    const blocks = results.filter((result) => result.kind === "block");
    expect(blocks).toHaveLength(8);
    const newlyClaimed = blocks.filter((result) => result.kind === "block" && result.reason === "claimed");
    expect(newlyClaimed).toHaveLength(1);
    const claimedRef = newlyClaimed[0]?.kind === "block" ? newlyClaimed[0].ref : null;
    expect(claimedRef).toBeTruthy();
    expect(blocks.every((result) => result.kind === "block" && result.ref === claimedRef)).toBe(true);
  });

  it("does not double-claim under concurrent dispatch claims", async () => {
    const readyCount = 5;
    const { root } = await createTestWorkspace(multiReadyManifest(readyCount));
    const refs = Array.from({ length: readyCount }, (_, index) => `T-${String(index + 1).padStart(3, "0")}#B-001`);
    const results = await Promise.all(refs.map((ref) => claimBlock({ projectRoot: root, ref, dispatch: true })));
    const claimed = results.map((result) => {
      expect(result).toMatchObject({ kind: "block", reason: "dispatched" });
      if (result.kind !== "block") {
        throw new Error("expected block claim");
      }
      return result.ref;
    });
    expect(new Set(claimed).size).toBe(readyCount);
    const secondWave = await Promise.all(refs.map((ref) => claimBlock({ projectRoot: root, ref, dispatch: true })));
    expect(secondWave.every((result) => result.kind === "blocked")).toBe(true);
  });

  it("does not lose concurrent updateTaskIndex increments", async () => {
    const { init } = await createTestWorkspace();
    const increments = 20;
    await Promise.all(
      Array.from({ length: increments }, () =>
        updateTaskIndex(init.workspace, "T-001", (index) => ({
          ...index,
          counts: {
            ...(index.counts ?? {}),
            runs: ((index.counts ?? {}).runs ?? 0) + 1
          }
        }))
      )
    );
    const final = await updateTaskIndex(init.workspace, "T-001", (index) => index);
    expect(final.counts?.runs).toBe(increments);
  });

  it("allocates unique run ids under concurrent allocateRunId", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "planweave-run-ids-"));
    const ids = await Promise.all(Array.from({ length: 16 }, () => allocateRunId(runRoot)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves state.json mtime unchanged across getExecutionStatus reads", async () => {
    const { root, init } = await createTestWorkspace();
    await loadRuntime({ projectRoot: root });
    const before = await stat(init.workspace.stateFile);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await getExecutionStatus({ projectRoot: root });
    await getExecutionStatus({ projectRoot: root });
    const after = await stat(init.workspace.stateFile);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
