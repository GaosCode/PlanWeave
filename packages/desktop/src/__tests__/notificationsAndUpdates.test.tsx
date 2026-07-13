/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdateToast } from "../renderer/components/AppUpdateToast";
import { createTranslator } from "../renderer/i18n";
import { NotificationsView } from "../renderer/views/NotificationsView";
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

    expect(screen.getByText("通知").closest("[data-slot='card']")).toBeNull();
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

  it("offers GitHub Releases download on unsigned macOS delivery instead of in-app install", async () => {
    const onDownload = vi.fn().mockResolvedValue(undefined);
    const onInstall = vi.fn().mockResolvedValue(undefined);

    render(
      <AppUpdateToast
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
    expect(screen.getByText(/Unsigned macOS builds cannot auto-install/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start download" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart to install" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Download from GitHub Releases" }));

    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });
});
