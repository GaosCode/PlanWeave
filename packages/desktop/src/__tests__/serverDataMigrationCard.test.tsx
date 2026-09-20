/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { ServerDataMigrationCard } from "../renderer/settings/ServerDataMigrationCard";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";

function apiStub(overrides: Partial<PlanWeaveCollaborationApi> = {}): PlanWeaveCollaborationApi {
  return {
    listServerDataExportSources: vi.fn().mockResolvedValue({
      sources: [{ id: "this_computer", occupied: true, running: false }]
    }),
    exportServerDataArchive: vi.fn().mockResolvedValue({ status: "exported", fileCount: 2 }),
    restoreServerDataArchive: vi.fn().mockResolvedValue({ status: "restored", fileCount: 2 }),
    ...overrides
  } as PlanWeaveCollaborationApi;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ServerDataMigrationCard", () => {
  it("exports from this computer", async () => {
    const user = userEvent.setup();
    const api = apiStub();
    render(<ServerDataMigrationCard api={api} t={createTranslator("en")} />);

    expect(await screen.findByTestId("server-data-migration")).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Export local data" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Restore on this computer" })).toBeVisible();
    await user.click(screen.getByTestId("server-data-export"));
    expect(api.exportServerDataArchive).toHaveBeenCalledWith({ sourceId: "this_computer" });
    expect(await screen.findByTestId("server-data-migration-status")).toHaveTextContent(
      "Archive saved."
    );
  });

  it("confirms overwrite and retries restore without picking a new file", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const restoreServerDataArchive = vi
      .fn()
      .mockResolvedValueOnce({ status: "needs_overwrite" })
      .mockResolvedValueOnce({ status: "restored", fileCount: 2 });
    const api = apiStub({ restoreServerDataArchive });
    render(<ServerDataMigrationCard api={api} t={createTranslator("zh-CN")} />);

    await user.click(await screen.findByTestId("server-data-import"));
    expect(restoreServerDataArchive.mock.calls[0]).toEqual([]);
    expect(confirm).toHaveBeenCalled();
    expect(restoreServerDataArchive).toHaveBeenNthCalledWith(2, { overwrite: true });
    expect(await screen.findByTestId("server-data-migration-status")).toHaveTextContent(
      "Server 数据已恢复"
    );
  });

  it.each([
    "en",
    "zh-CN"
  ] as const)("shows every partial export and recovery outcome in %s", async (language) => {
    const t = createTranslator(language);
    const cases = [
      [{ status: "resource_limit" }, "settingsServerDataResourceLimit", "server-data-import"],
      [
        { status: "exported_without_identity", fileCount: 2, reason: "missing_identity" },
        "settingsServerDataIdentityMissing",
        "server-data-export"
      ],
      [
        { status: "exported_without_identity", fileCount: 2, reason: "nonpersistent_credentials" },
        "settingsServerDataIdentityNonpersistent",
        "server-data-export"
      ],
      [
        { status: "exported_without_identity", fileCount: 2, reason: "snapshot_failed" },
        "settingsServerDataIdentityFailed",
        "server-data-export"
      ],
      [{ status: "not_restored" }, "settingsServerDataNotRestored", "server-data-import"],
      [{ status: "recovery_required" }, "settingsServerDataRecoveryRequired", "server-data-import"],
      [
        { status: "restored_cleanup_failed" },
        "settingsServerDataCleanupFailed",
        "server-data-import"
      ]
    ] as const;
    for (const [result, key, button] of cases) {
      const api = apiStub({
        exportServerDataArchive: vi.fn().mockResolvedValue(result),
        restoreServerDataArchive: vi.fn().mockResolvedValue(result)
      });
      const view = render(<ServerDataMigrationCard api={api} t={t} />);
      await userEvent.setup().click(await screen.findByTestId(button));
      expect(await screen.findByTestId("server-data-migration-status")).toHaveTextContent(t(key));
      view.unmount();
    }
  });

  it("disables export and import while the local Server is running", async () => {
    const api = apiStub({
      listServerDataExportSources: vi.fn().mockResolvedValue({
        sources: [{ id: "this_computer", occupied: true, running: true }]
      })
    });
    render(<ServerDataMigrationCard api={api} t={createTranslator("en")} />);
    expect(await screen.findByTestId("server-data-export")).toBeDisabled();
    expect(screen.getByTestId("server-data-import")).toBeDisabled();
    expect(screen.getByTestId("server-data-migration-status")).toHaveTextContent(
      "Stop the Server on this computer before moving data."
    );
  });
});
