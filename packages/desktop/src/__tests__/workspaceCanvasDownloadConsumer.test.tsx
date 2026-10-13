// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

installProviderHarness();

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

async function mountDownloadingProvider() {
  bridges.status.current = null;
  bridges.collaboration.target.listCollaborationAuthorizedProjects = vi
    .fn()
    .mockResolvedValue({ items: [], nextCursor: null });
  bridges.collaboration.target.listCollaborationAuthorizedCanvases = vi
    .fn()
    .mockResolvedValue({ items: [], nextCursor: null });
  const pending = deferred<WorkspaceCanvasDownloadResult>();
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
    authorityMode: "offline_cache_readonly",
    readOnly: true,
    cachedAt: "2026-08-22T00:00:00.000Z",
    conflict: null,
    rejectCode: null,
    replica: { ...cachedProjection(), canvasId: opened.canvasId }
  }));
  bridges.collaboration.target.downloadWorkspaceCanvasFork = vi.fn(() => pending.promise);
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
    />
  );
  await waitFor(() => expect(value().graphWorkspace.graph?.projectTitle).toBe("Cached Workspace"));
  expect(value().graphWorkspace.onDownloadWorkspaceFork).toBeTypeOf("function");
  let downloading: Promise<void> | undefined;
  act(() => {
    downloading = value().graphWorkspace.onDownloadWorkspaceFork!();
  });
  expect(bridges.collaboration.target.downloadWorkspaceCanvasFork).toHaveBeenCalledOnce();
  return {
    mounted,
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
    ["home", "canvas", "profile", "home ABA", "canvas ABA", "unmount"].flatMap((change) =>
      [false, true].map((failed) => ({ change, failed }))
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
