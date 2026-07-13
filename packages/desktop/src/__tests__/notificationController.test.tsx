/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import { useNotificationController } from "../renderer/controllers/NotificationController";
import { createTranslator } from "../renderer/i18n";
import { autoRunState } from "./helpers/autoRunControlHarness";

function controllerArgs() {
  return {
    applyLocalPromptConflicts: vi.fn().mockResolvedValue(undefined),
    autoRunState: autoRunState({
      projectRoot: "/projects/authority",
      canvasId: "canvas-authority",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/projects/authority/results/metadata.json"
    }),
    fileSyncDiagnostics: [],
    graph: null,
    handleRevealPathInFinder: vi.fn().mockResolvedValue(undefined),
    keepLocalPromptConflicts: vi.fn(),
    lastFileChange: null,
    navigationContext: null,
    openRunWorkspace: vi.fn().mockResolvedValue(undefined),
    openTaskWorkspace: vi.fn(),
    pendingImportRecoveries: [],
    promptConflicts: [],
    reloadPromptConflicts: vi.fn().mockResolvedValue(undefined),
    rollbackPendingImportRecovery: vi.fn().mockResolvedValue({ status: "rolledBack" }),
    setError: vi.fn(),
    setSuccessMessage: vi.fn(),
    settings: defaultDesktopSettings,
    t: createTranslator("en"),
    updateSettings: vi.fn()
  };
}

describe("notification navigation controller", () => {
  it("delegates direct and lookup intents without deriving identity from display text", async () => {
    const args = controllerArgs();
    const { result } = renderHook(() => useNotificationController(args));
    const latest = result.current.notificationItems.find((item) =>
      item.id.startsWith("latest-record:")
    );
    if (!latest) {
      throw new Error("Expected latest record notification.");
    }

    await act(async () => {
      await result.current.onOpenNotification(latest);
      await result.current.onOpenNotification({
        id: "direct",
        title: "display title",
        detail: "not an identity",
        tone: "secondary",
        read: false,
        navigationIntent: {
          kind: "task-workspace",
          target: {
            projectRoot: "/projects/direct",
            canvasId: "canvas-direct",
            taskId: "T-DIRECT"
          }
        }
      });
    });

    expect(args.openRunWorkspace).toHaveBeenCalledWith({
      projectRoot: "/projects/authority",
      canvasId: "canvas-authority",
      recordId: "T-001#B-001::RUN-001"
    });
    expect(args.openTaskWorkspace).toHaveBeenCalledWith({
      projectRoot: "/projects/direct",
      canvasId: "canvas-direct",
      taskId: "T-DIRECT"
    });
  });

  it("surfaces record authority rejection without navigating successfully", async () => {
    const args = controllerArgs();
    args.openRunWorkspace.mockRejectedValueOnce(new Error("Run record response mismatched."));
    const { result } = renderHook(() => useNotificationController(args));
    const latest = result.current.notificationItems.find((item) =>
      item.id.startsWith("latest-record:")
    );
    if (!latest) {
      throw new Error("Expected latest record notification.");
    }

    await act(async () => result.current.onOpenNotification(latest));

    expect(args.setError).toHaveBeenCalledWith("Run record response mismatched.");
  });
});
