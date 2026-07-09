import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeStateSchema } from "../schema/runtimeState.js";
import { createEmptyState, ensureStateForManifest, readState, writeState } from "../state.js";
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
    await expect(readState(join("/tmp", `planweave-missing-state-${Date.now()}.json`))).resolves.toEqual(createEmptyState());
  });
});
