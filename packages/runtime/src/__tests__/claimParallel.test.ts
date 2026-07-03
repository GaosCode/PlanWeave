import { describe, expect, it } from "vitest";
import { claimNext } from "../taskManager/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

describe("parallel claim", () => {
  it("returns a batch only when package parallel execution is enabled", async () => {
    const disabled = await createTestWorkspace(basicManifest({ parallel: false, includeSecondTask: true }));

    expect(await claimNext({ projectRoot: disabled.root, parallel: true })).toMatchObject({ kind: "blocked" });

    const enabled = await createTestWorkspace(basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true }));

    expect(await claimNext({ projectRoot: enabled.root, parallel: true })).toEqual({
      kind: "batch",
      refs: ["T-001#B-001", "T-002#B-001"],
      effectiveExecutors: {
        "T-001#B-001": "default",
        "T-002#B-001": "default"
      }
    });
  });
});
