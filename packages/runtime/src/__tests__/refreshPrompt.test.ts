import { describe, expect, it } from "vitest";
import { refreshPrompt } from "../prompt/refreshPrompt.js";
import { refreshPrompts } from "../prompt/refreshPrompts.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

describe("refreshPrompt", () => {
  it("renders block prompt surfaces without writing managed sections into source files", async () => {
    const { root } = await createTestWorkspace();

    const one = await refreshPrompt({ projectRoot: root, ref: "T-001#B-001" });
    const all = await refreshPrompts({ projectRoot: root });

    expect(one.ref).toBe("T-001#B-001");
    expect(one.markdown).toContain("planweave submit-result T-001#B-001 --report");
    expect(all.prompts.map((prompt) => prompt.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
  });
});
