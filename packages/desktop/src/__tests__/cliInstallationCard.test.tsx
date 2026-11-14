/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliInstallationCard } from "../renderer/settings/CliInstallationCard";
import { createTranslator } from "../renderer/i18n";
import type { CliInstallation } from "../shared/cliInstallation";

const t = createTranslator("zh-CN");
const missing: CliInstallation = {
  cli: { status: "missing" },
  node: { status: "available", path: "/bin/node", version: "v22.13.0" },
  npm: { status: "available", path: "/bin/npm", version: "10.0.0" },
  nodeSupported: true,
  shellEnvironmentError: null
};
const detect = vi.fn<() => Promise<CliInstallation>>();
const copyInstallCommand = vi.fn<() => Promise<void>>();
beforeEach(() => {
  detect.mockReset().mockResolvedValue(missing);
  copyInstallCommand.mockReset().mockResolvedValue(undefined);
  window.planweaveCliInstallation = { detect, copyInstallCommand };
});
afterEach(() => {
  cleanup();
  delete window.planweaveCliInstallation;
});

describe("CLI installation card", () => {
  it("offers the install command only when needed and refreshes after installation", async () => {
    const user = userEvent.setup();
    render(<CliInstallationCard t={t} />);
    await user.click(await screen.findByRole("button", { name: "复制安装命令" }));
    expect(copyInstallCommand).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "已复制" })).toBeVisible();
    detect.mockResolvedValue({
      ...missing,
      cli: { status: "available", path: "/usr/local/bin/planweave", version: "0.4.0" }
    });
    await user.click(screen.getByRole("button", { name: "重新检测" }));
    expect(await screen.findByText("已安装 · 0.4.0")).toBeVisible();
    expect(screen.getByText("/usr/local/bin/planweave")).toBeVisible();
    expect(screen.queryByRole("button", { name: "复制安装命令" })).not.toBeInTheDocument();
  });

  it("shows prerequisites instead of an install action when Node is too old", async () => {
    detect.mockResolvedValue({ ...missing, nodeSupported: false });
    render(<CliInstallationCard t={t} />);
    expect(await screen.findByText(/请先安装 Node.js/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "复制安装命令" })).not.toBeInTheDocument();
  });

  it("keeps the install action unavailable until a retry can confirm the CLI is missing", async () => {
    detect.mockResolvedValue({
      ...missing,
      cli: { status: "unknown" },
      shellEnvironmentError: "Login shell timed out."
    });
    render(<CliInstallationCard t={t} />);
    expect(await screen.findByText("未能确认是否已安装")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Login shell timed out.");
    expect(screen.queryByText("未安装")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制安装命令" })).not.toBeInTheDocument();

    detect.mockResolvedValue(missing);
    await userEvent.click(screen.getByRole("button", { name: "重新检测" }));
    expect(await screen.findByRole("button", { name: "复制安装命令" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps broken installations distinct from missing ones and exposes refresh failures", async () => {
    detect.mockResolvedValue({
      ...missing,
      cli: { status: "unavailable", path: "/bin/planweave", error: "permission denied" }
    });
    render(<CliInstallationCard t={t} />);
    expect(await screen.findByText("CLI 不可用")).toBeVisible();
    expect(screen.getByText("permission denied")).toBeVisible();
    expect(screen.queryByText("未安装")).not.toBeInTheDocument();
    detect.mockRejectedValue(new Error("probe timed out"));
    await userEvent.click(screen.getByRole("button", { name: "重新检测" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("probe timed out");
    await waitFor(() => expect(screen.getByRole("button", { name: "重新检测" })).toBeEnabled());
    expect(screen.queryByText("CLI 不可用")).not.toBeInTheDocument();
  });
});
