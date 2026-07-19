import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initManagedProject } from "@planweave-ai/runtime";
import { desktopBridgeInvokeChannels } from "../shared/ipcChannels";
import {
  registeredHandler,
  resetRuntimeBridgeMocks,
  restoreRuntimeBridgeEnv
} from "./support/runtimeBridgeTestHarness";

describe("canvas map layout IPC contract", () => {
  let home: string;

  beforeEach(async () => {
    await resetRuntimeBridgeMocks();
    home = await mkdtemp(join(tmpdir(), "planweave-layout-ipc-home-"));
    process.env.PLANWEAVE_HOME = home;
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();
  });

  afterEach(async () => {
    await restoreRuntimeBridgeEnv();
    await rm(home, { recursive: true, force: true });
  });

  it("forwards raw layout payloads and rejects malformed IPC input at the schema boundary", async () => {
    const project = await initManagedProject("IPC Layout Contract");
    const handler = registeredHandler(desktopBridgeInvokeChannels.saveCanvasMapLayout);

    await expect(
      handler(
        {},
        project.rootPath,
        // Deliberately untyped / malformed transport payload.
        {
          version: "desktop-canvas-map-layout/v0",
          projectId: 123,
          nodes: "not-an-array"
        }
      )
    ).rejects.toThrow();

    await expect(handler({}, project.rootPath, null)).rejects.toThrow();
  });

  it("keeps RUNTIME-SOLE ownership: main does not pre-parse canvas map layout with desktop layout schema", async () => {
    const project = await initManagedProject("IPC Layout Sole Boundary");
    const handler = registeredHandler(desktopBridgeInvokeChannels.saveCanvasMapLayout);

    // A payload that would pass a wrong main-side desktop-layout schema must still be rejected
    // by the runtime canvas-map schema (version / shape), proving sole structural authority.
    await expect(
      handler(
        {},
        project.rootPath,
        {
          version: "desktop-layout/v1",
          projectId: project.projectId,
          nodes: [{ nodeId: "T-001", x: 0, y: 0 }],
          updatedAt: "2026-07-19T00:00:00.000Z"
        }
      )
    ).rejects.toThrow(/canvas map layout/i);
  });
});
