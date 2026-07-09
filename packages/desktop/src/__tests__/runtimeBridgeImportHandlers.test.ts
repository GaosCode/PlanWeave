import {
  getRuntimeBridgeMocks,
  resetRuntimeBridgeMocks,
  restoreRuntimeBridgeEnv
} from "./support/runtimeBridgeTestHarness.js";
import {
  desktopBridgeInvokeChannels
} from "../shared/ipcChannels";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { electronMock, runtimeMock } = getRuntimeBridgeMocks();

describe("runtime bridge handlers: import recovery", () => {
  beforeEach(async () => {
    await resetRuntimeBridgeMocks();
  });

  afterEach(async () => {
    await restoreRuntimeBridgeEnv();
  });

  it("lists pending import recoveries through the runtime recovery API", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.listPendingImportRecoveries);
    expect(handler).toBeDefined();

    await expect(handler?.(null, "/tmp/project")).resolves.toEqual([
      {
        transactionId: "import-tx-1",
        recoveryRoot: "/tmp/project/desktop/recovery/package-import/import-tx-1",
        createdAt: "2026-07-06T00:00:00.000Z",
        operationCount: 2,
        phases: ["prepared", "applied"]
      }
    ]);

    expect(runtimeMock.resolveTaskCanvasWorkspace).not.toHaveBeenCalled();
    expect(runtimeMock.listPendingImportRecoveries).toHaveBeenCalledWith("/tmp/project");
  });

  it("rolls back a pending import recovery through the runtime recovery API", async () => {
    const { registerRuntimeBridgeHandlers } = await import("../main/runtimeBridgeHandlers");
    registerRuntimeBridgeHandlers();

    const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.rollbackPendingImportRecovery);
    expect(handler).toBeDefined();

    await handler?.(null, "/tmp/project", "import-tx-1");

    expect(runtimeMock.resolveTaskCanvasWorkspace).not.toHaveBeenCalled();
    expect(runtimeMock.rollbackPendingImportRecovery).toHaveBeenCalledWith("/tmp/project", "import-tx-1");
  });
});
