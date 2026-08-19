/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { ServerDataMigrationCard } from "../renderer/settings/ServerDataMigrationCard";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";

function installSelectDomStubs() {
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false)
  });
  Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
}

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

beforeEach(() => {
  installSelectDomStubs();
});

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
