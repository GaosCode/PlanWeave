/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppOverlays } from "../renderer/components/AppOverlays";
import { AppUpdateProvider } from "../renderer/components/AppUpdateProvider";
import { AppUpdateSurface } from "../renderer/components/AppUpdateSurface";
import { AppUpdateToast } from "../renderer/components/AppUpdateToast";
import { useDesktopErrorState } from "../renderer/hooks/useDesktopErrorState";
import { createTranslator } from "../renderer/i18n";
import { AppUpdateSettingsRow } from "../renderer/settings/AppUpdateSettingsRow";
import { NotificationsView } from "../renderer/views/NotificationsView";
import type { AppUpdateState } from "../shared/appUpdate";
import { available, downloaded, downloading, idle, updateBridge } from "./helpers/appUpdateFixture";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("desktop renderer component interactions", () => {
  it("opens only notifications carrying an authoritative navigation intent", async () => {
    const onOpenNotification = vi.fn().mockResolvedValue(undefined);
    const item = {
      id: "dirty-T-001",
      title: "Dirty prompt",
      detail: "T-001",
      tone: "secondary" as const,
      read: false,
      navigationIntent: {
        kind: "task-workspace" as const,
        target: {
          projectRoot: "/projects/demo",
          canvasId: "canvas-main",
          taskId: "T-001"
        }
      }
    };

    render(
      <NotificationsView
        notificationItems={[item]}
        onMarkNotificationRead={vi.fn()}
        onOpenNotification={onOpenNotification}
        t={createTranslator("zh-CN")}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(onOpenNotification).toHaveBeenCalledWith(item);
  });

  it("marks individual notifications as read from the message close button", async () => {
    const onMarkNotificationRead = vi.fn();

    render(
      <NotificationsView
        notificationItems={[
          {
            id: "latest-record:/tmp/record.json",
            title: "最新记录",
            detail: "/tmp/record.json",
            tone: "outline",
            read: false
          },
          {
            id: "dirty-T-001",
            title: "Dirty prompt",
            detail: "T-001",
            tone: "secondary",
            read: true
          }
        ]}
        onMarkNotificationRead={onMarkNotificationRead}
        t={createTranslator("zh-CN")}
      />
    );

    expect(screen.queryByRole("heading", { name: "通知" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "通知" })).toBeInTheDocument();
    expect(screen.getByText("未读")).toBeInTheDocument();
    expect(screen.getByText("已读")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "标记为已读: 最新记录" }));

    expect(onMarkNotificationRead).toHaveBeenCalledWith("latest-record:/tmp/record.json");
  });

  it("starts downloading from the update toast without installing immediately", async () => {
    const onDownload = vi.fn().mockResolvedValue(undefined);
    const onInstall = vi.fn().mockResolvedValue(undefined);

    render(
      <AppUpdateToast
        actionError={null}
        actionPending={false}
        onCheck={vi.fn().mockResolvedValue(undefined)}
        onDownload={onDownload}
        onInstall={onInstall}
        state={{
          status: "available",
          checkedAt: "2026-06-19T00:00:00.000Z",
          currentVersion: "0.1.1",
          delivery: "in-app",
          error: null,
          progress: null,
          update: { version: "0.1.2", releaseDate: null, releaseName: null },
          updatedAt: "2026-06-19T00:00:01.000Z"
        }}
        t={createTranslator("zh-CN")}
      />
    );

    expect(screen.getByTestId("app-update-toast")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "开始下载更新" }));

    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("offers GitHub Releases download when macOS delivery is not a verified signed release", async () => {
    const onDownload = vi.fn().mockResolvedValue(undefined);
    const onInstall = vi.fn().mockResolvedValue(undefined);

    render(
      <AppUpdateToast
        actionError={null}
        actionPending={false}
        onCheck={vi.fn().mockResolvedValue(undefined)}
        onDownload={onDownload}
        onInstall={onInstall}
        state={{
          status: "available",
          checkedAt: "2026-06-19T00:00:00.000Z",
          currentVersion: "0.1.1",
          delivery: "github-releases",
          error: null,
          progress: null,
          update: { version: "0.1.2", releaseDate: null, releaseName: null },
          updatedAt: "2026-06-19T00:00:01.000Z"
        }}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("app-update-toast")).toBeInTheDocument();
    expect(screen.getByText(/not verified as a signed release/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start download" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart to install" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Download from GitHub Releases" }));

    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });
});

const en = createTranslator("en");
const workspaceError = "Could not open workspace";

function UpdateOverlays({ settingsOpen = false }: { settingsOpen?: boolean }) {
  const { error, setError } = useDesktopErrorState();
  return (
    <AppUpdateProvider>
      <button type="button" onClick={() => setError(workspaceError)}>
        Open workspace
      </button>
      <AppOverlays
        error={error}
        setError={setError}
        setSuccessMessage={vi.fn()}
        successMessage={null}
        t={en}
      />
      {settingsOpen && <AppUpdateSettingsRow t={en} />}
    </AppUpdateProvider>
  );
}

function renderUpdateSettings(language: "en" | "zh-CN" = "en") {
  return render(<AppUpdateSettingsRow t={createTranslator(language)} />, {
    wrapper: AppUpdateProvider
  });
}

describe("App update settings", () => {
  it.each([
    { state: available, label: "Start download", command: "downloadAppUpdate" },
    {
      state: { ...available, delivery: "github-releases" } satisfies AppUpdateState,
      label: "Download from GitHub Releases",
      command: "downloadAppUpdate"
    },
    { state: downloaded, label: "Restart to install", command: "installAppUpdate" }
  ] as const)("keeps $label available after dismissing the notification", async ({
    state,
    label,
    command
  }) => {
    const bridge = updateBridge(state);
    const user = userEvent.setup();
    const content = (settingsOpen: boolean) => (
      <AppUpdateProvider>
        <AppUpdateSurface t={en} />
        {settingsOpen && <AppUpdateSettingsRow t={en} />}
      </AppUpdateProvider>
    );
    const view = render(content(false));
    const toast = await screen.findByRole("complementary");
    await user.click(within(toast).getByRole("button", { name: "Close" }));
    view.rerender(content(true));

    const action = await screen.findByRole("button", { name: label });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.tab();
    expect(action).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(bridge[command]).toHaveBeenCalledTimes(1);

    view.rerender(content(false));
    view.rerender(content(true));
    expect(await screen.findByRole("button", { name: label })).toBeEnabled();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it.each([
    { state: { ...idle, status: "checking" }, label: "Checking" },
    { state: downloading, label: "Downloading update" },
    {
      state: { ...idle, status: "unsupported", error: "Only in packaged builds" },
      label: "Check for updates"
    }
  ] satisfies Array<{
    state: AppUpdateState;
    label: string;
  }>)("blocks commands while $state.status", async ({ state, label }) => {
    const bridge = updateBridge(state);
    const user = userEvent.setup();
    await act(async () => renderUpdateSettings());

    const action = screen.getByRole("button", { name: label });
    if (state.status === "unsupported") {
      expect(action).toBeDisabled();
      expect(screen.getByText(en("appUpdateUnsupported"))).toBeVisible();
    } else {
      expect(action).toHaveAttribute("aria-disabled", "true");
    }
    await user.click(action);
    expect(bridge.checkForAppUpdate).not.toHaveBeenCalled();
    expect(bridge.downloadAppUpdate).not.toHaveBeenCalled();
  });

  it("explains why checking is unavailable when the desktop bridge is missing", () => {
    vi.stubGlobal("planweaveAppUpdate", undefined);
    renderUpdateSettings();

    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(screen.getByText(/update bridge is unavailable/i)).toBeVisible();
  });

  it("offers a new check when main reports a failed update", async () => {
    const bridge = updateBridge({ ...idle, status: "error", error: "Could not reach the feed" });
    bridge.checkForAppUpdate.mockResolvedValue({ ...idle, status: "not-available" });
    const user = userEvent.setup();
    renderUpdateSettings();

    expect(await screen.findByText("Could not reach the feed")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("PlanWeave Desktop is up to date.")).toBeVisible();
  });

  it("shows a rejected bridge action and retries the same command in Chinese", async () => {
    const bridge = updateBridge(downloaded);
    const request = Promise.withResolvers<AppUpdateState>();
    bridge.installAppUpdate.mockReturnValueOnce(request.promise);
    const user = userEvent.setup();
    renderUpdateSettings("zh-CN");

    const install = await screen.findByRole("button", { name: "重启安装" });
    await user.tab();
    await user.keyboard("{Enter}{Enter}");
    expect(install).toHaveFocus();
    expect(install).toHaveAttribute("aria-disabled", "true");
    expect(bridge.installAppUpdate).toHaveBeenCalledTimes(1);

    await act(async () => request.reject(new Error("IPC disconnected")));
    expect(screen.getByRole("alert")).toHaveTextContent("IPC disconnected");
    expect(install).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(bridge.installAppUpdate).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps subscription progress when the initial snapshot arrives late", async () => {
    const bridge = updateBridge(available);
    const snapshot = Promise.withResolvers<AppUpdateState>();
    bridge.getAppUpdateState.mockReturnValueOnce(snapshot.promise);
    renderUpdateSettings();
    act(() => bridge.publish(downloading));
    await act(async () => snapshot.resolve(idle));

    expect(screen.getByText("Downloading update · 42%")).toBeVisible();
  });

  it("keeps a downloaded update when an older action response has the same timestamp", async () => {
    const bridge = updateBridge(available);
    const action = Promise.withResolvers<AppUpdateState>();
    bridge.downloadAppUpdate.mockReturnValueOnce(action.promise);
    renderUpdateSettings();
    const download = await screen.findByRole("button", { name: "Start download" });
    download.focus();
    fireEvent.click(download);

    act(() => bridge.publish(downloading));
    expect(screen.getByRole("button", { name: "Downloading update" })).toHaveFocus();

    act(() => bridge.publish(downloaded));
    await act(async () => action.resolve({ ...downloading, updatedAt: downloaded.updatedAt }));
    expect(screen.getByRole("button", { name: "Restart to install" })).toHaveFocus();
  });

  it("clears a download failure after retrying from the notification", async () => {
    const bridge = updateBridge(available);
    bridge.downloadAppUpdate
      .mockRejectedValueOnce(new Error("IPC disconnected"))
      .mockResolvedValueOnce(downloaded);
    const user = userEvent.setup();
    render(<UpdateOverlays />);

    const toast = await screen.findByRole("complementary");
    const download = within(toast).getByRole("button", { name: "Start download" });
    await user.click(download);
    expect(within(toast).getByText(/IPC disconnected/)).toBeVisible();

    await user.click(download);
    expect(await within(toast).findByText("Update downloaded")).toBeVisible();
    expect(bridge.downloadAppUpdate).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/IPC disconnected/)).not.toBeInTheDocument();
  });

  it("retries a failed notification request from reopened settings without replacing an unrelated error", async () => {
    const bridge = updateBridge(downloaded);
    const request = Promise.withResolvers<AppUpdateState>();
    bridge.installAppUpdate.mockReturnValueOnce(request.promise);
    const user = userEvent.setup();
    const view = render(<UpdateOverlays />);
    const toast = await screen.findByRole("complementary");
    await user.click(within(toast).getByRole("button", { name: "Restart to install" }));
    await user.click(within(toast).getByRole("button", { name: "Close" }));
    view.rerender(<UpdateOverlays settingsOpen />);

    const install = screen.getByRole("button", { name: "Restart to install" });
    expect(install).toHaveAttribute("aria-disabled", "true");
    await user.click(install);
    expect(bridge.installAppUpdate).toHaveBeenCalledTimes(1);

    view.rerender(<UpdateOverlays />);
    await user.click(screen.getByRole("button", { name: "Open workspace" }));
    await act(async () => request.reject(new Error("IPC disconnected")));
    view.rerender(<UpdateOverlays settingsOpen />);
    expect(screen.getByText(`${en("appUpdateRequestFailed")} IPC disconnected`)).toBeVisible();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restart to install" }));
    expect(bridge.installAppUpdate).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/IPC disconnected/)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(workspaceError);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("shows a current error response when it follows a progress event", async () => {
    const bridge = updateBridge(available);
    const action = Promise.withResolvers<AppUpdateState>();
    bridge.downloadAppUpdate.mockReturnValueOnce(action.promise);
    renderUpdateSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Start download" }));

    act(() => bridge.publish(downloading));
    await act(async () =>
      action.resolve({ ...downloaded, status: "error", error: "The download failed" })
    );
    expect(screen.getByText("The download failed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });
});
