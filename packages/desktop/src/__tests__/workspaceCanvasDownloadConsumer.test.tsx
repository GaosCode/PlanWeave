// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopProjectSnapshot, DesktopProjectSummary } from "@planweave-ai/runtime";
import type { ProjectWorkspaceValue } from "../renderer/ProjectWorkspaceProvider";
import type { ProjectWorkspaceShellInput } from "../renderer/projectWorkspaceShell";
import type { DesktopSettingsUpdate } from "../renderer/types";
import type { WorkspaceCanvasDownloadResult } from "../shared/workspaceCanvasSharing";
import { createTranslator } from "../renderer/i18n";
import { deferred, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import {
  bridges,
  locator,
  ProviderHarness,
  workspaceSettings,
  cachedProjection,
  connectedWorkspaceStatus,
  installProviderHarness
} from "./helpers/projectWorkspaceProviderHarness";
import { WorkspaceTabs } from "../renderer/views/WorkspaceTabs";

installProviderHarness();
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => vi.unstubAllGlobals());

const nextCanvas = { ...locator, canvasId: "canvas-next" };
const nextWorkspace = { ...locator, workspaceId: "workspace-next" };

function downloadResult(): WorkspaceCanvasDownloadResult {
  return {
    locator: { kind: "local", projectId: project.projectId, canvasId: "canvas-main" },
    localProjectId: project.projectId,
    localCanvasId: "canvas-main",
    writeback: false,
    lineage: {
      schemaVersion: "workspace-fork-lineage/v1",
      writeback: false,
      source: {
        scope: {
          workspaceId: locator.workspaceId,
          projectId: locator.projectId,
          canvasId: locator.canvasId
        },
        revision: 4,
        content: {
          versionId: "version-download",
          canonicalDigest: "a".repeat(64),
          verification: "complete"
        }
      }
    }
  };
}

async function mountDownloadingProvider({ connected = false, start = true } = {}) {
  bridges.status.current = connected ? connectedWorkspaceStatus() : null;
  bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
    .fn()
    .mockResolvedValue({ items: [], nextCursor: null });
  bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi.fn().mockResolvedValue({
    items: [locator, nextCanvas, nextWorkspace].map((registry) => ({ registry })),
    nextCursor: null
  });
  const pending = deferred<WorkspaceCanvasDownloadResult>();
  const download = vi.fn(() => pending.promise);
  const onError = vi.fn();
  const onSuccess = vi.fn();
  let current: ProjectWorkspaceValue | null = null;
  let settings = { ...workspaceSettings(), planweaveHome: "/home-a" };
  let update: ProjectWorkspaceShellInput["updateSettings"] | null = null;
  const value = () => {
    if (!current) throw new Error("Provider has not rendered");
    return current;
  };
  bridges.collaboration.target.openWorkspaceCanvasSession = vi.fn(async (opened) => ({
    locator: opened,
    status: "accepted",
    authorityMode: connected ? "server_authoritative" : "offline_cache_readonly",
    readOnly: !connected,
    cachedAt: connected ? null : "2026-08-22T00:00:00.000Z",
    initialRuntimeAvailability: null,
    conflict: null,
    rejectCode: null,
    replica: { ...cachedProjection(), workspaceId: opened.workspaceId, canvasId: opened.canvasId }
  }));
  bridges.collaboration.target.downloadWorkspaceCanvasFork = download;
  bridges.desktop.target.listProjects = vi.fn(async () => [
    {
      ...project,
      rootPath: `${settings.planweaveHome}/projects/${project.projectId}`,
      workspaceRoot: `${settings.planweaveHome}/projects/${project.projectId}`
    }
  ]);
  const mounted = render(
    <ProviderHarness
      initialSettings={settings}
      onError={onError}
      onSuccess={onSuccess}
      onSettings={(next) => {
        settings = next;
      }}
      onValue={(next) => {
        current = next;
      }}
      onUpdateSettings={(next) => {
        update = next;
      }}
    >
      {start ? null : <WorkspaceTabs />}
    </ProviderHarness>
  );
  await waitFor(() => expect(value().graphWorkspace.graph?.projectTitle).toBe("Cached Workspace"));
  expect(value().graphWorkspace.onDownloadWorkspaceFork).toBeTypeOf("function");
  let downloading: Promise<void> | undefined;
  if (start) {
    act(() => {
      downloading = value().graphWorkspace.onDownloadWorkspaceFork!();
    });
    expect(download).toHaveBeenCalledOnce();
  }
  return {
    mounted,
    download,
    pending,
    onError,
    onSuccess,
    downloading,
    value,
    settings: () => settings,
    update: (patch: DesktopSettingsUpdate) => {
      if (!update) throw new Error("Provider settings are unavailable");
      update(patch);
    }
  };
}

describe("Workspace download consumer ownership", () => {
  it("admits one same-tick download and shows progress through the Local Canvas handoff", async () => {
    const f = await mountDownloadingProvider({ connected: true, start: false });
    const button = await screen.findByRole("button", { name: "Download Local fork" });
    expect(button).toBeEnabled();
    const onDownload = f.value().graphWorkspace.onDownloadWorkspaceFork!;
    let downloading: Promise<void> | undefined;
    act(() => {
      downloading = onDownload();
      void onDownload();
    });
    expect(f.download).toHaveBeenCalledExactlyOnceWith({
      workspaceId: locator.workspaceId,
      projectId: locator.projectId,
      canvasId: locator.canvasId,
      projectName: "Cached Workspace"
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName("Downloading Local fork…");

    const list = deferred<DesktopProjectSummary[]>();
    const snapshot = deferred<DesktopProjectSnapshot>();
    const downloaded = {
      ...project,
      rootPath: `/home-a/projects/${project.projectId}`,
      workspaceRoot: `/home-a/projects/${project.projectId}`
    };
    vi.mocked(bridges.desktop.target.listProjects).mockReturnValueOnce(list.promise);
    vi.mocked(bridges.desktop.target.getDesktopProjectSnapshot).mockReturnValueOnce(
      snapshot.promise
    );
    await act(async () => f.pending.resolve(downloadResult()));
    expect(f.settings().lastOpenedWorkspaceLocator).toBeNull();
    expect(f.value().shell.selectedProject).toBeNull();
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName("Downloading Local fork…");
    await act(async () => list.resolve([downloaded]));
    expect(f.value().shell.selectedProject?.projectId).toBe(downloadResult().localProjectId);
    expect(f.value().shell.selectedCanvasId).toBe(downloadResult().localCanvasId);
    expect(button).toBeDisabled();
    expect(f.onSuccess).not.toHaveBeenCalled();

    await act(async () => {
      snapshot.resolve(projectSnapshot());
      await downloading;
    });
    expect(f.settings().runtimePath).toBe(downloaded.workspaceRoot);
    expect(f.onSuccess).toHaveBeenCalledExactlyOnceWith(
      createTranslator("en")("downloadWorkspaceForkSuccess")
    );
    expect(button).not.toBeInTheDocument();
  });

  it("accepts keyboard activation, disables repeat activation, and allows a click retry after failure", async () => {
    const f = await mountDownloadingProvider({ connected: true, start: false });
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Download Local fork" });
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}{Enter} ");
    expect(f.download).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    await act(async () => f.pending.reject(new Error("network unavailable")));
    expect(f.onError).toHaveBeenCalledExactlyOnceWith("network unavailable");
    expect(f.onSuccess).not.toHaveBeenCalled();
    expect(f.settings().lastOpenedWorkspaceLocator).toEqual(locator);
    expect(button).toBeEnabled();
    expect(button).toHaveAccessibleName("Download Local fork");

    const retry = deferred<WorkspaceCanvasDownloadResult>();
    f.download.mockReturnValueOnce(retry.promise);
    await user.dblClick(button);
    expect(f.download).toHaveBeenCalledTimes(2);
    expect(button).toBeDisabled();
    await act(async () => retry.resolve(downloadResult()));
    expect(f.onSuccess).toHaveBeenCalledOnce();
    expect(button).not.toBeInTheDocument();
  });

  it.each([
    "canvas",
    "workspace",
    "home"
  ])("retires pending after %s changes and keeps the next download pending when the old one settles", async (change) => {
    const f = await mountDownloadingProvider({ connected: true, start: false });
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Download Local fork" });
    await user.click(button);
    expect(button).toBeDisabled();

    const next =
      change === "canvas" ? nextCanvas : change === "workspace" ? nextWorkspace : locator;
    if (change === "home") act(() => f.update({ planweaveHome: "/home-b" }));
    else act(() => f.value().shell.openWorkspaceCanvasLocator(next));
    expect(button).toBeEnabled();
    const pending = deferred<WorkspaceCanvasDownloadResult>();
    f.download.mockReturnValueOnce(pending.promise);
    await user.click(button);
    expect(f.download).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: next.workspaceId,
        canvasId: next.canvasId
      })
    );
    expect(button).toBeDisabled();

    await act(async () => f.pending.resolve(downloadResult()));
    expect(button).toBeDisabled();
    expect(f.onSuccess).not.toHaveBeenCalled();
    expect(f.settings().lastOpenedWorkspaceLocator).toEqual(next);
    await act(async () => pending.reject(new Error("new download unavailable")));
    expect(button).toBeEnabled();
    expect(f.onError).toHaveBeenLastCalledWith("new download unavailable");
  });

  it("keeps the download unavailable on the offline Workspace Canvas", async () => {
    const f = await mountDownloadingProvider({ start: false });
    const button = await screen.findByRole("button", { name: "Download Local fork" });
    expect(button).toBeDisabled();
    expect(f.download).not.toHaveBeenCalled();
  });

  it.each(
    ["list", "snapshot"].flatMap((stage) =>
      ["home", "canvas", "credential", "unmount"].flatMap((change) =>
        [false, true].map((failed) => ({ stage, change, failed }))
      )
    )
  )("retires $stage completion after $change changes (failed=$failed)", async ({
    stage,
    change,
    failed
  }) => {
    const f = await mountDownloadingProvider();
    const entered = deferred<void>();
    const list = deferred<DesktopProjectSummary[]>();
    const snapshot = deferred<DesktopProjectSnapshot>();
    const downloaded = {
      ...project,
      rootPath: `/home-a/projects/${project.projectId}`,
      workspaceRoot: `/home-a/projects/${project.projectId}`
    };
    if (stage === "list") {
      vi.mocked(bridges.desktop.target.listProjects).mockImplementationOnce(() => {
        entered.resolve();
        return list.promise;
      });
    } else {
      bridges.desktop.target.getDesktopProjectSnapshot = vi
        .fn()
        .mockResolvedValue(projectSnapshot())
        .mockImplementationOnce(() => {
          entered.resolve();
          return snapshot.promise;
        });
    }
    await act(async () => {
      f.pending.resolve(downloadResult());
      await entered.promise;
    });
    if (change === "home") act(() => f.update({ planweaveHome: "/home-b" }));
    else if (change === "canvas") {
      act(() =>
        f.value().shell.openWorkspaceCanvasLocator({ ...locator, canvasId: "canvas-next" })
      );
    } else if (change === "credential") {
      bridges.status.current = connectedWorkspaceStatus();
      act(() => f.update({ reducedMotion: true }));
    } else f.mounted.unmount();
    const before = {
      locator: f.settings().lastOpenedWorkspaceLocator,
      runtimePath: f.settings().runtimePath,
      projectRoot: f.value().shell.selectedProject?.rootPath
    };
    f.onError.mockClear();
    f.onSuccess.mockClear();
    vi.mocked(bridges.desktop.target.refreshPackageFileChanges).mockClear();
    vi.mocked(bridges.desktop.target.watchPackageFiles).mockClear();
    await act(async () => {
      if (stage === "list") {
        if (failed) list.reject(new Error("retired_project_list_failure"));
        else list.resolve([downloaded]);
      } else {
        if (failed) snapshot.reject(new Error("retired_project_snapshot_failure"));
        else snapshot.resolve(projectSnapshot());
      }
      await f.downloading;
    });
    expect(f.settings().lastOpenedWorkspaceLocator).toEqual(before.locator);
    expect(f.settings().runtimePath).toBe(before.runtimePath);
    expect(f.value().shell.selectedProject?.rootPath).toBe(before.projectRoot);
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.onSuccess).not.toHaveBeenCalled();
    expect(bridges.desktop.target.refreshPackageFileChanges).not.toHaveBeenCalled();
    expect(bridges.desktop.target.watchPackageFiles).not.toHaveBeenCalled();
  });

  it.each(
    ["home", "canvas", "workspace", "profile", "home ABA", "canvas ABA", "unmount"].flatMap(
      (change) => [false, true].map((failed) => ({ change, failed }))
    )
  )("retires the download after $change changes (failed=$failed)", async ({ change, failed }) => {
    const f = await mountDownloadingProvider();
    if (change === "home" || change === "home ABA") {
      act(() => f.update({ planweaveHome: "/home-b" }));
      if (change === "home ABA") act(() => f.update({ planweaveHome: "/home-a" }));
    } else if (change === "canvas" || change === "canvas ABA") {
      act(() =>
        f.value().shell.openWorkspaceCanvasLocator({ ...locator, canvasId: "canvas-next" })
      );
      if (change === "canvas ABA") act(() => f.value().shell.openWorkspaceCanvasLocator(locator));
    } else if (change === "workspace") {
      act(() => f.value().shell.openWorkspaceCanvasLocator(nextWorkspace));
    } else if (change === "profile") {
      const next = connectedWorkspaceStatus();
      next.activeProfileId = "profile-next";
      next.profiles[0] = { ...next.profiles[0]!, profileId: "profile-next" };
      bridges.status.current = next;
      act(() => f.update({ reducedMotion: true }));
    } else f.mounted.unmount();
    const before = {
      locator: f.settings().lastOpenedWorkspaceLocator,
      runtimePath: f.settings().runtimePath
    };
    vi.mocked(bridges.desktop.target.listProjects).mockClear();
    f.onError.mockClear();
    f.onSuccess.mockClear();
    await act(async () => {
      if (failed) f.pending.reject(new Error("retired_download_failure"));
      else f.pending.resolve(downloadResult());
      await f.downloading;
    });
    expect(f.settings().lastOpenedWorkspaceLocator).toEqual(before.locator);
    expect(f.settings().runtimePath).toBe(before.runtimePath);
    expect(bridges.desktop.target.listProjects).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.onSuccess).not.toHaveBeenCalled();
  });

  it.each([false, true])("consumes the current download normally (failed=%s)", async (failed) => {
    const f = await mountDownloadingProvider();
    await act(async () => {
      if (failed) f.pending.reject(new Error("current_download_failure"));
      else f.pending.resolve(downloadResult());
      await f.downloading;
    });
    if (failed) expect(f.onError).toHaveBeenCalledWith("current_download_failure");
    else {
      expect(f.settings().lastOpenedWorkspaceLocator).toBeNull();
      expect(f.settings().runtimePath).toBe(`/home-a/projects/${project.projectId}`);
      expect(f.onSuccess).toHaveBeenCalledWith(
        createTranslator("en")("downloadWorkspaceForkSuccess")
      );
    }
  });
});
