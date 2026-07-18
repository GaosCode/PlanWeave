import { describe, expect, it } from "vitest";

describe("runtime package entry", () => {
  it("exports the Desktop runner record subscription contract", async () => {
    const runtime = await import("@planweave-ai/runtime");

    expect(runtime.subscribeRunRecord).toBeTypeOf("function");
  });

  it("exports the canonical managed process tree launcher", async () => {
    const runtime = await import("@planweave-ai/runtime");

    expect(runtime.spawnManagedProcess).toBeTypeOf("function");
    expect(runtime.createHostProcessTreeAdapter).toBeTypeOf("function");
  });
});
