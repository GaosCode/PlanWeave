/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopAgentDetection, ExecutionHost } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsPanel } from "../renderer/components/AgentSettingsPanel";
import { resetAgentCapabilityProbeSessionCache } from "../renderer/components/agentCapabilityProbeSessionCache";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";
import { deferred } from "./helpers/desktopProjectFixtures";

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
  executionHost: { kind: "native" },
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
  agentAcpOptionsHint: "Configure ACP options.",
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

function capabilityResult(host: ExecutionHost, name: string) {
  return {
    ...successfulProbeResult,
    executionHost: host,
    sessionConfig: {
      modes: null,
      configOptions: [
        {
          id: "fixture-option",
          type: "boolean" as const,
          name,
          description: null,
          currentValue: true
        }
      ]
    }
  };
}

function panel(projectRoot: string, executionHost = defaultDesktopSettings.execution.agentHost) {
  return (
    <AgentSettingsPanel
      agentDetectionRefreshing={false}
      agents={[{ ...agent, executionHost }]}
      labels={labels}
      projectRoot={projectRoot}
      refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
      settings={{
        ...defaultDesktopSettings,
        execution: { ...defaultDesktopSettings.execution, agentHost: executionHost }
      }}
      t={createTranslator("en")}
      updateSettings={vi.fn()}
    />
  );
}

function renderPanel(projectRoot: string) {
  return render(panel(projectRoot));
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

  it("reprobes an expanded agent on confirmed host changes and ignores replies from earlier visits", async () => {
    const native = { kind: "native" } as const;
    const ubuntu = { kind: "wsl", distribution: "Ubuntu" } as const;
    const debian = { kind: "wsl", distribution: "Debian" } as const;
    const firstNative = deferred<ReturnType<typeof capabilityResult>>();
    const firstUbuntu = deferred<ReturnType<typeof capabilityResult>>();
    const firstDebian = deferred<ReturnType<typeof capabilityResult>>();
    const currentUbuntu = deferred<ReturnType<typeof capabilityResult>>();
    bridgeMock.probeDesktopAgentCapabilities
      .mockReturnValueOnce(firstNative.promise)
      .mockReturnValueOnce(firstUbuntu.promise)
      .mockReturnValueOnce(firstDebian.promise)
      .mockReturnValueOnce(currentUbuntu.promise);

    const view = render(panel("/projects/a", native));
    await userEvent.click(screen.getByRole("button", { name: "Codex ACP options" }));
    expect(bridgeMock.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(1);

    view.rerender(panel("/projects/a", ubuntu));
    expect(bridgeMock.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(2);
    view.rerender(panel("/projects/a", debian));
    expect(bridgeMock.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(3);
    view.rerender(panel("/projects/a", { ...ubuntu }));
    expect(bridgeMock.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(4);

    await act(() => currentUbuntu.resolve(capabilityResult(ubuntu, "Current Ubuntu option")));
    await waitFor(() => expect(screen.getByText("Current Ubuntu option")).toBeVisible());
    await act(async () => {
      firstNative.resolve(capabilityResult(native, "Stale Native option"));
      firstDebian.resolve(capabilityResult(debian, "Stale Debian option"));
      firstUbuntu.reject(new Error("Stale Ubuntu error"));
    });
    expect(screen.getByText("Current Ubuntu option")).toBeVisible();
    expect(screen.queryByText("Stale Native option")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale Debian option")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale Ubuntu error")).not.toBeInTheDocument();
  });
});
