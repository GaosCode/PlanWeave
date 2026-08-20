import { describe, expect, it, vi } from "vitest";
import {
  actor,
  canvasCommandServiceFixture as fixture
} from "./support/canvasCommandServiceFixture.js";

const missingPackageLocation = {
  scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
  projectRoot: "/Users/missing/planweave-project",
  packageDir: "/Users/missing/planweave-project/package",
  aclRevision: 1
};

describe("canvas command runtime status without a local package", () => {
  it("projects fail-closed status from authoritative content when the bound path is missing", async () => {
    const { service, access, runtime } = await fixture();
    vi.spyOn(access, "resolveAuthorizedCanvas").mockReturnValue(missingPackageLocation);
    const readStatus = vi.spyOn(runtime, "readStatus");

    await expect(
      service.readRuntimeStatus(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-status/v2",
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      tasks: [{ taskId: "T-001", status: "planned", openFeedbackCount: 0 }],
      blocks: [
        expect.objectContaining({
          ref: "T-001#B-001",
          status: "planned",
          dispatchable: false
        }),
        expect.objectContaining({
          ref: "T-001#R-001",
          status: "planned",
          dispatchable: false
        })
      ]
    });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("rejects with a typed unavailable error when content and package are both missing", async () => {
    const { service, access, contentVersions } = await fixture();
    vi.spyOn(access, "resolveAuthorizedCanvas").mockReturnValue(missingPackageLocation);
    vi.spyOn(contentVersions, "head").mockReturnValue(null);

    await expect(
      service.readRuntimeStatus(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).rejects.toThrow("canvas_runtime_status_unavailable");
  });
});
