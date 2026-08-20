import { describe, expect, it, vi } from "vitest";
import type { CanvasRuntimeStatusPort } from "../canvas/runtimePort.js";
import {
  actor,
  canvasCommandServiceFixture as fixture,
  fakeRuntime
} from "./support/canvasCommandServiceFixture.js";

describe("canvas command runtime status", () => {
  it("passes only the authorized logical scope to the status port", async () => {
    const runtime = fakeRuntime();
    const read = vi.spyOn(runtime, "read");
    const { service } = await fixture({ runtime });

    await expect(
      service.readRuntimeStatus(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-status/v2",
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" }
    });
    expect(read).toHaveBeenCalledWith(
      { workspaceId: "w", projectId: "p", canvasId: "default" },
      "2026-01-02T00:00:00.000Z"
    );
  });

  it("does not consult restored registry paths before reading runtime status", async () => {
    const runtime = fakeRuntime();
    const { service, access, database } = await fixture({ runtime });
    database.exec(
      "UPDATE project_registry SET project_root_internal=NULL; UPDATE canvas_registry SET package_dir_internal=NULL"
    );
    const pathResolver = vi.spyOn(access.registry, "resolveCanvasPath");

    await expect(
      service.readRuntimeStatus(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).resolves.toMatchObject({ schemaVersion: "canvas-runtime-status/v2" });
    expect(pathResolver).not.toHaveBeenCalled();
  });

  it("maps status port failures to the existing unavailable contract", async () => {
    const runtime: CanvasRuntimeStatusPort = {
      async read() {
        throw new Error("canvas_runtime_unavailable");
      }
    };
    const { service } = await fixture({ runtime });

    await expect(
      service.readRuntimeStatus(actor("viewer"), { projectId: "p", canvasId: "default" })
    ).rejects.toMatchObject({
      message: "canvas_runtime_status_unavailable",
      cause: expect.objectContaining({ message: "canvas_runtime_unavailable" })
    });
  });
});
