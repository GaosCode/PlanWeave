import { describe, expect, it } from "vitest";
import { ensureStateForManifest, createEmptyState } from "../state.js";
import { basicManifest } from "./promptTestHelpers.js";

describe("task status aggregation", () => {
  it("aggregates implemented only after required non-review blocks complete and required review passes", () => {
    const manifest = basicManifest();
    let state = ensureStateForManifest(manifest, createEmptyState());
    expect(state.tasks["T-001"]?.status).toBe("ready");

    state.blocks["T-001#B-001"] = { ...state.blocks["T-001#B-001"], status: "completed" };
    state = ensureStateForManifest(manifest, state);
    expect(state.tasks["T-001"]?.status).toBe("in_progress");

    state.blocks["T-001#R-001"] = {
      ...state.blocks["T-001#R-001"],
      status: "completed",
      completionReason: "passed"
    };
    state = ensureStateForManifest(manifest, state);

    expect(state.tasks["T-001"]?.status).toBe("implemented");
  });
});
