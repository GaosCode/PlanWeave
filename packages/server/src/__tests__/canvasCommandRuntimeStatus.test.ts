import { describe, expect, it, vi } from "vitest";
import {
  actor,
  canvasCommandServiceFixture as fixture,
  fakeRuntime
} from "./support/canvasCommandServiceFixture.js";

const missingPackageLocation = {
  scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
  projectRoot: "/Users/missing/planweave-project",
  packageDir: "/Users/missing/planweave-project/package",
  aclRevision: 1
};

describe("canvas command runtime status without a local package", () => {
  it("rejects as unavailable when the bound path is missing", async () => {
    const { service, access, runtime } = await fixture();
    vi.spyOn(access, "resolveAuthorizedCanvas").mockReturnValue(missingPackageLocation);
    const readStatus = vi.spyOn(runtime, "readStatus");

    await expect(
      service.readRuntimeStatus(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).rejects.toThrow("canvas_runtime_status_unavailable");
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("rejects as unavailable when no local runtime path is bound", async () => {
    const { service, access, runtime } = await fixture();
    vi.spyOn(access, "resolveAuthorizedCanvas").mockImplementation(() => {
      throw new Error("canvas_path_not_bound");
    });
    const readStatus = vi.spyOn(runtime, "readStatus");

    await expect(
      service.readRuntimeStatus(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).rejects.toThrow("canvas_runtime_status_unavailable");
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("rejects as unavailable when the local runtime lacks status capability", async () => {
    const runtimeWithoutStatus = fakeRuntime();
    delete runtimeWithoutStatus.readStatus;
    const { service } = await fixture({ runtime: runtimeWithoutStatus });

    await expect(
      service.readRuntimeStatus(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).rejects.toThrow("canvas_runtime_status_unavailable");
  });

  it("maps local runtime read failures to unavailable without returning a projection", async () => {
    const { service, runtime } = await fixture();
    vi.spyOn(runtime, "readStatus").mockRejectedValue(new Error("runtime_state_missing"));

    await expect(
      service.readRuntimeStatus(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).rejects.toMatchObject({
      message: "canvas_runtime_status_unavailable",
      cause: expect.objectContaining({ message: "runtime_state_missing" })
    });
  });
});
