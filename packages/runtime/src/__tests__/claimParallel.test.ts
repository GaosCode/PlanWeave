import { describe, expect, it } from "vitest";
import { claimNextParallel } from "../tasks/claimParallel.js";
import { baseManifest, createPackageWorkspace } from "./promptTestHelpers.js";

describe("claimNextParallel", () => {
  it("greedily claims safe tasks without dependency or lock conflicts", async () => {
    const { root } = await createPackageWorkspace(
      baseManifest({
        execution: { parallel: { enabled: true, maxConcurrent: 3 } },
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "First",
            prompt: "nodes/T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: true, locks: ["runtime"] }
          },
          {
            id: "T-002",
            type: "task",
            title: "Second",
            prompt: "nodes/T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: true, locks: ["runtime"] }
          },
          {
            id: "T-003",
            type: "task",
            title: "Third",
            prompt: "nodes/T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: true, locks: ["cli"] }
          },
          {
            id: "T-004",
            type: "task",
            title: "Fourth",
            prompt: "nodes/T-001.prompt.md",
            acceptance: ["done"],
            parallel: { safe: false, locks: [] }
          }
        ],
        edges: []
      })
    );

    const result = await claimNextParallel({ projectRoot: root });

    expect(result.status).toBe("claimed");
    expect(result.taskIds).toEqual(["T-001", "T-003"]);
    delete process.env.PLANWEAVE_HOME;
  });
});
