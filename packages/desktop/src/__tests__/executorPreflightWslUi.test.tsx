/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";
import { SettingsAgentsSection } from "../renderer/settings/SettingsAgentsSection";

const bridgeMock = vi.hoisted(() => ({
  api: {
    detectWslEnvironment: vi.fn(),
    probeDesktopAgentCapabilities: vi.fn(),
    testExecutorProfile: vi.fn()
  }
}));

vi.mock("../renderer/bridge", () => ({
  bridge: bridgeMock.api,
  collaborationBridge: null,
  desktopCanvasReference: (project: DesktopProjectSummary, canvasId?: string | null) => ({
    projectRoot: project.rootPath,
    canvasId
  })
}));

const t = createTranslator("en");
const canvasRef = { projectRoot: "/tmp/project", canvasId: "canvas-main" };
const graph: DesktopGraphViewModel = {
  projectId: "P-001",
  projectTitle: "Project",
  graphVersion: "pgv-test",
  packageFingerprint: "pkg-test",
  executorOptions: ["codex"],
  autoRunPreflightExecutorHint: "codex",
  tasks: [],
  edges: [],
  sharedResourceGroups: [],
  diagnostics: [],
  dirtyPromptRefs: []
};

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

beforeEach(() => {
  bridgeMock.api.detectWslEnvironment.mockResolvedValue({
    supported: true,
    available: true,
    distributions: ["Ubuntu", "Debian"],
    unavailableReason: null
  });
});

afterEach(() => {
  cleanup();
  bridgeMock.api.detectWslEnvironment.mockReset();
});

describe("executor preflight WSL desktop UI", () => {
  it("selects an explicit WSL distribution before persisting the execution host", async () => {
    installSelectDomStubs();
    const updateSettings = vi.fn();
    const refreshAgentDetections = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[]}
        canvasRef={canvasRef}
        graph={graph}
        refreshAgentDetections={refreshAgentDetections}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={updateSettings}
      />
    );

    const hostSelect = await screen.findByRole("combobox", { name: "Agent host" });
    await userEvent.click(hostSelect);
    await userEvent.click(screen.getByRole("option", { name: "WSL" }));

    expect(updateSettings).not.toHaveBeenCalled();
    const distributionSelect = screen.getByRole("combobox", { name: "WSL distribution" });
    await userEvent.click(distributionSelect);
    await userEvent.click(screen.getByRole("option", { name: "Ubuntu" }));

    expect(updateSettings).toHaveBeenCalledWith({
      execution: { agentHost: { kind: "wsl", distribution: "Ubuntu" } }
    });
    await waitFor(() => expect(hostSelect).toBeEnabled());
  });
});
