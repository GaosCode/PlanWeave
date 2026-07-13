import { afterEach, describe, expect, it, vi } from "vitest";
import {
  safeRunnerEventTextSchema,
  utf8ByteLength
} from "../autoRun/runnerEventRedaction.js";

describe("runner event redaction browser compatibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("measures UTF-8 bytes without requiring the Node Buffer global", () => {
    vi.stubGlobal("Buffer", undefined);

    expect(utf8ByteLength("PlanWeave 界")).toBe(13);
    expect(safeRunnerEventTextSchema(3, "message").safeParse("界").success).toBe(true);
    expect(safeRunnerEventTextSchema(2, "message").safeParse("界").success).toBe(false);
  });
});
