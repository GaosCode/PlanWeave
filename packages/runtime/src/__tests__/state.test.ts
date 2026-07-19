import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeStateSchema } from "../schema/runtimeState.js";
import { createEmptyState, ensureStateForManifest, readState, writeState } from "../state.js";
import { claimBlock, getExecutionStatus } from "../taskManager/index.js";
import { loadRuntime, loadRuntimeReadonly } from "../taskManager/runtimeContext.js";
import type { RuntimeState } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

describe("readState Zod validation", () => {
  it("rejects malformed block status with a doctor-pointing error", async () => {
    const { init } = await createTestWorkspace();
    const malformed = {
      ...createEmptyState(),
      blocks: {
        "T-001#B-001": { status: "banana", lastRunId: null }
      }
    };
    await writeFile(init.workspace.stateFile, `${JSON.stringify(malformed, null, 2)}\n`, "utf8");

    await expect(readState(init.workspace.stateFile)).rejects.toThrow(
      /Runtime state at .* is invalid:.*status.*doctor/is
    );
  });

  it("rejects malformed currentRefs that are not a string array", async () => {
    const { init } = await createTestWorkspace();
    const malformed = {
      ...createEmptyState(),
      currentRefs: [1, null, "T-001#B-001"]
    };
    await writeFile(init.workspace.stateFile, `${JSON.stringify(malformed, null, 2)}\n`, "utf8");

    await expect(readState(init.workspace.stateFile)).rejects.toThrow(
      /Runtime state at .* is invalid:.*currentRefs/is
    );
  });

  it("rejects malformed task records", async () => {
    const { init } = await createTestWorkspace();
    const malformed = {
      ...createEmptyState(),
      tasks: {
        "T-001": { status: "ready" }
      }
    };
    await writeFile(init.workspace.stateFile, `${JSON.stringify(malformed, null, 2)}\n`, "utf8");

    await expect(readState(init.workspace.stateFile)).rejects.toThrow(
      /Runtime state at .* is invalid:.*tasks\.T-001/is
    );
  });

  it("rejects malformed block records missing required fields", async () => {
    const { init } = await createTestWorkspace();
    const malformed = {
      ...createEmptyState(),
      blocks: {
        "T-001#B-001": { lastRunId: "run-1" }
      }
    };
    await writeFile(init.workspace.stateFile, `${JSON.stringify(malformed, null, 2)}\n`, "utf8");

    await expect(readState(init.workspace.stateFile)).rejects.toThrow(
      /Runtime state at .* is invalid:.*blocks\.T-001#B-001/is
    );
  });

  it("round-trips a well-formed state file unchanged", async () => {
    const { init } = await createTestWorkspace();
    const state: RuntimeState = {
      currentRefs: ["T-001#B-001"],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {
        "T-001": { status: "in_progress", openFeedbackCount: 0 }
      },
      blocks: {
        "T-001#B-001": {
          status: "in_progress",
          lastRunId: "run-1",
          completionReason: null
        }
      },
      feedback: {
        "fb-1": {
          status: "open",
          sourceReviewBlockRef: "T-001#R-001",
          latestSubmissionId: null,
          content: "fix the edge case"
        }
      }
    };
    await writeState(init.workspace.stateFile, state);

    await expect(readState(init.workspace.stateFile)).resolves.toEqual(state);
  });

  it("accepts ensureStateForManifest output under runtimeStateSchema", async () => {
    const state = ensureStateForManifest(basicManifest(), createEmptyState());
    const parsed = runtimeStateSchema.safeParse(state);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(state);
    }
  });

  it("returns empty state when the state file is missing", async () => {
    await expect(
      readState(join("/tmp", `planweave-missing-state-${Date.now()}.json`))
    ).resolves.toEqual(createEmptyState());
  });
});

describe("ensureStateForManifest manifest-drift repair", () => {
  it("prunes stale current refs, review refs, feedback, and removed task/block records", () => {
    const wideManifest = basicManifest({ includeSecondTask: true });
    const seeded = ensureStateForManifest(wideManifest, createEmptyState());

    const drifted: RuntimeState = {
      ...seeded,
      currentRefs: ["T-001#B-001", "T-002#B-001", "T-404#B-001"],
      currentReviewBlockRef: "T-002#R-001",
      currentFeedbackId: "fb-stale-source",
      tasks: {
        ...seeded.tasks,
        "T-GONE": { status: "ready", openFeedbackCount: 0 }
      },
      blocks: {
        ...seeded.blocks,
        "T-002#B-001": { status: "completed", lastRunId: "run-old" },
        "T-GONE#B-001": { status: "completed", lastRunId: "run-gone" }
      },
      feedback: {
        "fb-keep": {
          status: "open",
          sourceReviewBlockRef: "T-001#R-001",
          latestSubmissionId: null,
          content: "still valid"
        },
        "fb-stale-source": {
          status: "open",
          sourceReviewBlockRef: "T-002#R-001",
          latestSubmissionId: null,
          content: "review removed with T-002"
        }
      }
    };

    // Narrower manifest: only T-001 remains (T-002 and synthetic T-GONE leave the package).
    const repaired = ensureStateForManifest(basicManifest(), drifted);

    expect(repaired.currentRefs).toEqual(["T-001#B-001"]);
    expect(repaired.currentReviewBlockRef).toBeNull();
    expect(repaired.currentFeedbackId).toBeNull();
    expect(Object.keys(repaired.tasks).sort()).toEqual(["T-001"]);
    expect(Object.keys(repaired.blocks).sort()).toEqual(["T-001#B-001", "T-001#R-001"]);
    // Existing implementation block stays ready; open feedback only affects task aggregate.
    expect(repaired.blocks["T-001#B-001"]?.status).toBe("ready");
    expect(repaired.tasks["T-001"]?.status).toBe("in_progress");
    expect(repaired.tasks["T-001"]?.openFeedbackCount).toBe(1);
    expect(repaired.feedback).toEqual({
      "fb-keep": {
        status: "open",
        sourceReviewBlockRef: "T-001#R-001",
        latestSubmissionId: null,
        content: "still valid"
      }
    });
    expect(repaired.blocks["T-002#B-001"]).toBeUndefined();
    expect(repaired.blocks["T-GONE#B-001"]).toBeUndefined();
    expect(repaired.tasks["T-GONE"]).toBeUndefined();
    expect(repaired.feedback["fb-stale-source"]).toBeUndefined();
  });

  it("clears currentFeedbackId when the envelope is resolved but keeps the feedback record", () => {
    const manifest = basicManifest();
    const base = ensureStateForManifest(manifest, createEmptyState());
    const withResolved: RuntimeState = {
      ...base,
      currentFeedbackId: "fb-1",
      feedback: {
        "fb-1": {
          status: "resolved",
          sourceReviewBlockRef: "T-001#R-001",
          latestSubmissionId: "sub-1",
          content: "done"
        }
      }
    };

    const repaired = ensureStateForManifest(manifest, withResolved);
    expect(repaired.currentFeedbackId).toBeNull();
    expect(repaired.feedback["fb-1"]?.status).toBe("resolved");
  });

  it("seeds newly added manifest blocks without reintroducing pruned records", () => {
    const single = ensureStateForManifest(basicManifest(), createEmptyState());
    expect(Object.keys(single.blocks).sort()).toEqual(["T-001#B-001", "T-001#R-001"]);

    const withSecond = ensureStateForManifest(basicManifest({ includeSecondTask: true }), single);
    expect(Object.keys(withSecond.tasks).sort()).toEqual(["T-001", "T-002"]);
    expect(withSecond.blocks["T-002#B-001"]?.status).toBe("ready");
    expect(withSecond.blocks["T-002#R-001"]?.status).toBe("planned");
  });
});

describe("loadRuntime derivation path", () => {
  it("loadRuntimeReadonly derives claimable ready blocks after pruning stale current refs", async () => {
    const { root, init } = await createTestWorkspace();
    const emptyDerived = ensureStateForManifest(basicManifest(), createEmptyState());
    const dirty: RuntimeState = {
      ...emptyDerived,
      currentRefs: ["T-404#B-001"],
      currentReviewBlockRef: "T-404#R-001",
      feedback: {
        "fb-orphan": {
          status: "open",
          sourceReviewBlockRef: "T-404#R-001",
          latestSubmissionId: null,
          content: "orphan"
        }
      }
    };
    await writeState(init.workspace.stateFile, dirty);

    const context = await loadRuntimeReadonly({ projectRoot: root });
    expect(context.rawState.currentRefs).toEqual(["T-404#B-001"]);
    expect(context.state.currentRefs).toEqual([]);
    expect(context.state.currentReviewBlockRef).toBeNull();
    expect(context.state.feedback).toEqual({});
    expect(context.state.blocks["T-001#B-001"]?.status).toBe("ready");

    const claim = await claimBlock({ projectRoot: root, ref: "T-001#B-001" });
    expect(claim).toMatchObject({ kind: "block", ref: "T-001#B-001" });

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.currentRefs).toEqual(["T-001#B-001"]);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("in_progress");
  });

  it("loadRuntime persists derivation when raw state drifted from the manifest", async () => {
    const { root, init } = await createTestWorkspace();
    const emptyDerived = ensureStateForManifest(basicManifest(), createEmptyState());
    const dirty: RuntimeState = {
      ...emptyDerived,
      currentRefs: ["T-999#B-001"],
      tasks: {
        ...emptyDerived.tasks,
        "T-999": { status: "ready", openFeedbackCount: 0 }
      }
    };
    await writeState(init.workspace.stateFile, dirty);

    const context = await loadRuntime({ projectRoot: root });
    expect(context.state.currentRefs).toEqual([]);
    expect(context.state.tasks["T-999"]).toBeUndefined();

    const onDisk = await readState(init.workspace.stateFile);
    expect(onDisk.currentRefs).toEqual([]);
    expect(onDisk.tasks["T-999"]).toBeUndefined();
    expect(Object.keys(onDisk.blocks).sort()).toEqual(["T-001#B-001", "T-001#R-001"]);
  });
});
