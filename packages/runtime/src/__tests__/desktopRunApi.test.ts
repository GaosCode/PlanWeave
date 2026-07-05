import { afterEach, describe, expect, it, vi } from "vitest";
import { getDesktopRuntimeRefresh } from "../desktop/index.js";
import * as projectProjectionModel from "../desktop/graph/projectProjectionModel.js";
import { invalidateDesktopProjectProjection } from "../desktop/graph/projectProjectionModel.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  invalidateDesktopProjectProjection();
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

describe("desktop run API", () => {
  it("returns lightweight runtime refresh data without reading project projection", async () => {
    const { root } = await createTestWorkspace();
    const readProjection = vi.spyOn(projectProjectionModel, "readDesktopProjectProjection");

    await expect(getDesktopRuntimeRefresh({ projectRoot: root, canvasId: null })).resolves.toEqual({
      latestAutoRun: null,
      diagnostics: [],
      errors: []
    });

    expect(readProjection).not.toHaveBeenCalled();
  });
});
