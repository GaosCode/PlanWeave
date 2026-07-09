import { describe, expect, it } from "vitest";
import { markBlockDiverged } from "../taskManager/index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

describe("markBlockDiverged", () => {
  it("requires a non-empty reason", async () => {
    const { root } = await createTestWorkspace();

    await expect(
      markBlockDiverged({ projectRoot: root, ref: "T-001#B-001", reason: " " })
    ).rejects.toThrow("mark-diverged requires a non-empty reason");
  });
});
