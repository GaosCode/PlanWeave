import { describe, expect, it } from "vitest";

describe("runtime package entry", () => {
  it("exports the Desktop runner record subscription contract", async () => {
    const runtime = await import("@planweave-ai/runtime");

    expect(runtime.subscribeRunRecord).toBeTypeOf("function");
  });
});
