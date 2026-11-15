/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { DeploymentConnectionCard } from "../renderer/settings/DeploymentConnectionCard";

const collaborationBridge = vi.hoisted(() => ({
  getActiveWorkspaceConnection: vi.fn(),
  listRememberedServerConnections: vi.fn(),
  getDesktopServerExposure: vi.fn(),
  getDeploymentGuidance: vi.fn(),
  validateDeploymentConnectivity: vi.fn(),
  copyDeploymentComposeHandoff: vi.fn(),
  exportDeploymentComposeBundle: vi.fn()
}));
vi.mock("../renderer/bridge", () => ({ collaborationBridge }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function guidanceFor(target: { displayName: string; endpoint: { serverOrigin: string } }) {
  return {
    target,
    handoff: {
      state: "supported",
      preview: `compose for ${target.endpoint.serverOrigin}`,
      projectsMountTarget: "/var/lib/planweave/projects",
      trustedProjectRootPattern: "/var/lib/planweave/projects/<project-id>"
    }
  };
}

async function renderExistingServer(user: ReturnType<typeof userEvent.setup>) {
  const view = render(<DeploymentConnectionCard t={createTranslator("en")} />);
  await user.click(screen.getByTestId("deployment-kind"));
  await user.click(await screen.findByRole("option", { name: "Existing Server" }));
  await user.type(screen.getByTestId("deployment-display-name"), "Server A");
  fireEvent.change(screen.getByTestId("deployment-origin"), {
    target: { value: "https://a.example.test" }
  });
  return view;
}

describe("DeploymentConnectionCard target lifecycle", () => {
  beforeEach(() => {
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
    collaborationBridge.getActiveWorkspaceConnection.mockResolvedValue({
      profile: null,
      workspaceId: null
    });
    collaborationBridge.listRememberedServerConnections.mockResolvedValue([]);
    collaborationBridge.getDesktopServerExposure.mockResolvedValue({
      mode: "local_only",
      topology: "loopback_http",
      provider: null,
      lifecycle: "ready",
      advertisedOrigin: null,
      errorCode: null,
      canActivate: true,
      canInvite: true
    });
    collaborationBridge.getDeploymentGuidance.mockResolvedValue({
      handoff: { state: "unsupported" }
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hides completed checks on semantic target changes and keeps equivalent origins", async () => {
    const user = userEvent.setup();
    collaborationBridge.getDeploymentGuidance.mockImplementation(async (input) =>
      guidanceFor(input.target)
    );
    collaborationBridge.validateDeploymentConnectivity.mockResolvedValue({ status: "reachable" });
    const view = await renderExistingServer(user);
    await user.click(screen.getByRole("button", { name: "View deploy steps" }));
    await user.click(screen.getByRole("button", { name: "Validate endpoint" }));
    expect(await screen.findByTestId("deployment-guidance")).toHaveTextContent("a.example.test");
    expect(await screen.findByTestId("deployment-connectivity")).toHaveTextContent("Reachable");

    await user.type(screen.getByTestId("deployment-origin"), "/some/path");
    expect(screen.getByTestId("deployment-guidance")).toBeVisible();
    expect(screen.getByTestId("deployment-connectivity")).toBeVisible();
    view.rerender(<DeploymentConnectionCard t={createTranslator("zh-CN")} />);
    expect(screen.getByTestId("deployment-guidance")).toBeVisible();
    expect(screen.getByTestId("deployment-connectivity")).toHaveTextContent("可达");

    fireEvent.change(screen.getByTestId("deployment-display-name"), {
      target: { value: "Server B" }
    });
    expect(screen.queryByTestId("deployment-guidance")).not.toBeInTheDocument();
    expect(screen.getByTestId("deployment-connectivity")).toBeVisible();
    fireEvent.change(screen.getByTestId("deployment-origin"), {
      target: { value: "https://b.example.test" }
    });
    expect(screen.queryByTestId("deployment-connectivity")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看部署说明" }));
    await user.click(screen.getByRole("button", { name: "验证端点" }));
    expect(await screen.findByTestId("deployment-guidance")).toBeVisible();
    expect(await screen.findByTestId("deployment-connectivity")).toBeVisible();
    await user.click(screen.getByTestId("deployment-custom-topology"));
    await user.click(await screen.findByRole("option", { name: "私有网络 HTTPS" }));
    expect(screen.queryByTestId("deployment-guidance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deployment-connectivity")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看部署说明" }));
    await user.click(screen.getByRole("button", { name: "验证端点" }));
    expect(await screen.findByTestId("deployment-guidance")).toBeVisible();
    expect(await screen.findByTestId("deployment-connectivity")).toBeVisible();
    fireEvent.change(screen.getByTestId("deployment-origin"), { target: { value: "not a URL" } });
    expect(screen.getByRole("button", { name: "查看部署说明" })).toBeDisabled();
    expect(screen.queryByTestId("deployment-guidance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deployment-connectivity")).not.toBeInTheDocument();
  });

  it("ignores late A success and failure through A to B to A while checks run independently", async () => {
    const user = userEvent.setup();
    const oldGuidance = deferred<ReturnType<typeof guidanceFor>>();
    const currentGuidance = deferred<ReturnType<typeof guidanceFor>>();
    const oldValidation = deferred<{ status: string }>();
    const currentValidation = deferred<{ status: string }>();
    collaborationBridge.getDeploymentGuidance
      .mockReturnValueOnce(oldGuidance.promise)
      .mockReturnValueOnce(currentGuidance.promise);
    collaborationBridge.validateDeploymentConnectivity
      .mockReturnValueOnce(oldValidation.promise)
      .mockReturnValueOnce(currentValidation.promise);
    await renderExistingServer(user);
    const originInput = screen.getByTestId("deployment-origin");
    await user.click(screen.getByRole("button", { name: "View deploy steps" }));
    expect(screen.getByRole("button", { name: "Validate endpoint" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Validate endpoint" }));

    fireEvent.change(originInput, { target: { value: "https://b.example.test" } });
    fireEvent.change(originInput, { target: { value: "https://a.example.test" } });
    expect(screen.getByRole("button", { name: "View deploy steps" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Validate endpoint" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "View deploy steps" }));
    await user.click(screen.getByRole("button", { name: "Validate endpoint" }));
    await act(async () =>
      oldGuidance.resolve(
        guidanceFor(collaborationBridge.getDeploymentGuidance.mock.calls[0][0].target)
      )
    );
    await act(async () => oldValidation.reject(new Error("old target failed")));
    expect(screen.queryByTestId("deployment-guidance")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View deploy steps" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Validate endpoint" })).toBeDisabled();
    await act(async () => currentValidation.resolve({ status: "reachable" }));
    expect(screen.getByTestId("deployment-connectivity")).toHaveTextContent("Reachable");
    expect(screen.getByRole("button", { name: "View deploy steps" })).toBeDisabled();
    await act(async () =>
      currentGuidance.resolve(
        guidanceFor(collaborationBridge.getDeploymentGuidance.mock.calls[1][0].target)
      )
    );
    expect(screen.getByTestId("deployment-guidance")).toHaveTextContent("a.example.test");
  });

  it("copies and exports the visible guidance target and drops stale operation feedback", async () => {
    const user = userEvent.setup();
    collaborationBridge.getDeploymentGuidance.mockImplementation(async (input) =>
      guidanceFor(input.target)
    );
    const copy = deferred<void>();
    const exported = deferred<{ state: "exported" }>();
    collaborationBridge.copyDeploymentComposeHandoff.mockReturnValueOnce(copy.promise);
    collaborationBridge.exportDeploymentComposeBundle.mockReturnValueOnce(exported.promise);
    await renderExistingServer(user);
    const originInput = screen.getByTestId("deployment-origin");
    await user.click(screen.getByRole("button", { name: "View deploy steps" }));
    expect(await screen.findByTestId("deployment-guidance")).toHaveTextContent(
      "compose for https://a.example.test/"
    );
    await user.click(screen.getByRole("button", { name: "Copy supported Compose handoff" }));
    await user.click(screen.getByRole("button", { name: "Export self-host bundle" }));
    const shownTarget = collaborationBridge.getDeploymentGuidance.mock.calls[0][0].target;
    expect(collaborationBridge.copyDeploymentComposeHandoff).toHaveBeenCalledWith({
      action: "copy_supported_compose_handoff",
      target: shownTarget
    });
    expect(collaborationBridge.exportDeploymentComposeBundle).toHaveBeenCalledWith({
      action: "export_supported_compose_bundle",
      target: shownTarget
    });
    fireEvent.change(originInput, { target: { value: "https://b.example.test" } });
    expect(screen.queryByTestId("deployment-guidance")).not.toBeInTheDocument();
    await act(async () => copy.resolve());
    await act(async () => exported.resolve({ state: "exported" }));
    expect(
      screen.queryByText("The supported handoff was copied by Desktop main.")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Bundle exported. TLS files are not included.")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View deploy steps" }));
    expect(await screen.findByTestId("deployment-guidance")).toHaveTextContent("b.example.test");
    collaborationBridge.exportDeploymentComposeBundle.mockResolvedValueOnce({ state: "exported" });
    await user.click(screen.getByRole("button", { name: "Copy supported Compose handoff" }));
    await user.click(screen.getByRole("button", { name: "Export self-host bundle" }));
    expect(
      await screen.findByText("The supported handoff was copied by Desktop main.")
    ).toBeVisible();
    expect(await screen.findByText("Bundle exported. TLS files are not included.")).toBeVisible();
  });

  it("shows a current request failure and succeeds after retry", async () => {
    const user = userEvent.setup();
    collaborationBridge.getDeploymentGuidance.mockRejectedValueOnce(new Error("offline"));
    await renderExistingServer(user);
    await user.click(screen.getByRole("button", { name: "View deploy steps" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid or unavailable");
    collaborationBridge.getDeploymentGuidance.mockImplementationOnce(async (input) =>
      guidanceFor(input.target)
    );
    await user.click(screen.getByRole("button", { name: "View deploy steps" }));
    expect(await screen.findByTestId("deployment-guidance")).toHaveTextContent("a.example.test");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["deployment_archive_export_in_progress", "A Server bundle export is already in progress."],
    ["deployment_archive_destination_not_file", "Choose a regular file or a new filename."],
    [
      "deployment_archive_permissions_unavailable",
      "Choose a location that supports private file permissions."
    ],
    [
      "deployment_archive_committed_cleanup_failed",
      "The bundle was exported, but Desktop could not remove its temporary folder."
    ]
  ])("shows the export outcome for %s", async (code, message) => {
    const user = userEvent.setup();
    collaborationBridge.getDeploymentGuidance.mockImplementation(async (input) =>
      guidanceFor(input.target)
    );
    collaborationBridge.exportDeploymentComposeBundle.mockRejectedValueOnce({ code });
    await renderExistingServer(user);
    await user.click(screen.getByRole("button", { name: "View deploy steps" }));
    const exportButton = screen.getByRole("button", { name: "Export self-host bundle" });
    await user.click(exportButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(exportButton).toBeEnabled();
  });

  it("discards an action completion after unmount", async () => {
    const user = userEvent.setup();
    const pending = deferred<ReturnType<typeof guidanceFor>>();
    collaborationBridge.getDeploymentGuidance.mockReturnValueOnce(pending.promise);
    const view = await renderExistingServer(user);
    await user.click(screen.getByRole("button", { name: "View deploy steps" }));
    const target = collaborationBridge.getDeploymentGuidance.mock.calls[0][0].target;
    view.unmount();
    await act(async () => pending.resolve(guidanceFor(target)));
    expect(screen.queryByTestId("deployment-guidance")).not.toBeInTheDocument();
  });
});
