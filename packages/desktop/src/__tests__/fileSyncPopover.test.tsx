/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { FileSyncPopover } from "../renderer/run/FileSyncPopover";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");

afterEach(() => {
  cleanupRendererTestEnvironment();
});

describe("FileSyncPopover", () => {
  it("shows file sync counts, expandable details, and dispatches refresh/open actions", async () => {
    const refreshPackageFiles = vi.fn().mockResolvedValue(undefined);
    const onOpenFileSyncRef = vi.fn();

    render(
      <FileSyncPopover
        affectedTasks={["T-002"]}
        diagnostics={[
          {
            code: "prompt_changed",
            message: "Prompt changed on disk.",
            path: "nodes/T-001/prompt.md"
          }
        ]}
        dirtyPromptRefs={["T-001#B-001"]}
        disabled={false}
        issueCount={4}
        onOpenChange={vi.fn()}
        onOpenFileSyncRef={onOpenFileSyncRef}
        open={true}
        refreshConcurrency={3}
        refreshPackageFiles={refreshPackageFiles}
        refreshedPromptCount={2}
        showUnreadCount={true}
        t={t}
        watcherBackendKind="native"
        watcherChangedPathCount={5}
        watcherRefreshElapsedMs={1250}
      />
    );

    expect(screen.getByTestId("file-sync-popover")).toBeVisible();
    expect(screen.getByTestId("file-sync-unread-count")).toHaveTextContent("4");
    expect(screen.getByTestId("file-sync-refreshed-prompt-count")).toHaveTextContent("2");
    expect(screen.getByTestId("file-sync-refresh-concurrency")).toHaveTextContent("3");
    expect(screen.getByTestId("file-sync-changed-path-count")).toHaveTextContent("5");
    expect(screen.getByTestId("file-sync-watch-backend")).toHaveTextContent("native");

    await userEvent.click(screen.getByRole("button", { name: "Recheck files" }));
    expect(refreshPackageFiles).toHaveBeenCalledTimes(1);

    await userEvent.click(
      within(screen.getByTestId("file-sync-dirty-prompts-section")).getByRole("button", {
        name: "Dirty Prompts"
      })
    );
    await userEvent.click(screen.getByRole("button", { name: "T-001#B-001" }));
    expect(onOpenFileSyncRef).toHaveBeenCalledWith("T-001#B-001");

    await userEvent.click(
      within(screen.getByTestId("file-sync-affected-tasks-section")).getByRole("button", {
        name: "Affected tasks"
      })
    );
    expect(screen.getByRole("button", { name: "T-002" })).toBeInTheDocument();

    await userEvent.click(
      within(screen.getByTestId("file-sync-diagnostics-section")).getByRole("button", {
        name: "Diagnostics"
      })
    );
    expect(screen.getByTestId("file-sync-diagnostic")).toHaveTextContent("Prompt changed on disk.");
  });
});
