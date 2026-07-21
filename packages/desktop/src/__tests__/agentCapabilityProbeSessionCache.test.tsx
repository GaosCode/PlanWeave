/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopAgentDetection } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsPanel } from "../renderer/components/AgentSettingsPanel";
import { resetAgentCapabilityProbeSessionCache } from "../renderer/components/agentCapabilityProbeSessionCache";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";

const bridgeMock = vi.hoisted(() => ({
  probeDesktopAgentCapabilities: vi.fn()
}));

vi.mock("../renderer/bridge", () => ({ bridge: bridgeMock }));

const agent: DesktopAgentDetection = {
  runnerKind: "acp",
  kind: "codex",
  name: "Codex ACP",
  command: "codex-acp",
  versionArgs: ["--version"],
  execArgs: [],
  fullAccessArgs: [],
  installed: true,
  version: "1.0.0",
  unavailableReason: null
};

const successfulProbeResult = {
  agentKind: "codex" as const,
  ok: true,
  message: "ACP capability probe passed.",
  failureCode: null,
  agentInfo: { name: "Codex ACP", version: "1.0.0" },
  authentication: { status: "not_advertised" as const },
  capabilities: ["session"],
  checks: [{ check: "acp_initialized", status: "passed", message: "ACP initialize completed." }],
  sessionConfig: { modes: null, configOptions: [] }
};

const minimalProbeResult = {
  ...successfulProbeResult,
  agentInfo: null,
  checks: []
};

const labels = {
  agentDetected: "Agent detected",
  agentEnableDescription: "Run {command}",
  agentFullAccess: "Full access",
  agentFullAccessDescription: "Run {command}",
  agentInstallStatus: "Agent installation status",
  agentMissing: "Agent not detected",
  agentMissingCannotEnable: "Install before enabling.",
  agentAcpAdapterHint: "ACP adapter is separate from the CLI.",
  agentInstallCommandLabel: "Install command",
  agentLoginCommandLabel: "Login command",
  agentRefresh: "Refresh",
  agentRefreshing: "Refreshing",
  acpModelManaged: "Model is managed by the agent configuration.",
  acpPermissionsManaged: "Permissions are managed by the agent configuration.",
  acpSessionMode: "Session mode",
  acpNotProbed: "Click Refresh to test this agent again.",
  acpProbing: "Testing..."
};

function renderPanel(projectRoot: string) {
  return render(
    <AgentSettingsPanel
      agentDetectionRefreshing={false}
      agents={[agent]}
      labels={labels}
      projectRoot={projectRoot}
      refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
      settings={defaultDesktopSettings}
      t={createTranslator("en")}
      updateSettings={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  resetAgentCapabilityProbeSessionCache();
  bridgeMock.probeDesktopAgentCapabilities.mockReset();
});

describe("ACP capability probe session cache", () => {
  it("reuses a completed result after the Agents panel is remounted", async () => {
    bridgeMock.probeDesktopAgentCapabilities.mockResolvedValue(successfulProbeResult);

    const firstPanel = renderPanel("/projects/a");
    await userEvent.click(screen.getByRole("button", { name: "Codex ACP options" }));
    expect(await screen.findByText("Initialized successfully")).toBeInTheDocument();
    firstPanel.unmount();

    renderPanel("/projects/a");
    await userEvent.click(screen.getByRole("button", { name: "Codex ACP options" }));

    expect(screen.getByText("Initialized successfully")).toBeInTheDocument();
    expect(screen.queryByText("Testing...")).not.toBeInTheDocument();
    expect(bridgeMock.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a result for another project root", async () => {
    bridgeMock.probeDesktopAgentCapabilities.mockResolvedValue(minimalProbeResult);

    const firstPanel = renderPanel("/projects/a");
    await userEvent.click(screen.getByRole("button", { name: "Codex ACP options" }));
    expect(
      await screen.findByText("Model is managed by the agent configuration.")
    ).toBeInTheDocument();
    firstPanel.unmount();

    renderPanel("/projects/b");
    await userEvent.click(screen.getByRole("button", { name: "Codex ACP options" }));

    expect(
      await screen.findByText("Model is managed by the agent configuration.")
    ).toBeInTheDocument();
    expect(bridgeMock.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(2);
  });
});
