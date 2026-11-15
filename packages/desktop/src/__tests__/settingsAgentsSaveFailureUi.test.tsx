/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DesktopAgentCapabilityProbeResult,
  DesktopAgentDetection,
  ExecutionHost
} from "@planweave-ai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopSettingsBridge } from "../renderer/hooks/useDesktopSettingsBridge";
import { resetAgentCapabilityProbeSessionCache } from "../renderer/components/agentCapabilityProbeSessionCache";
import { useDetectedAgents } from "../renderer/hooks/useDetectedAgents";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings, mergeDesktopSettings } from "../renderer/settings";
import { SettingsAgentsSection } from "../renderer/settings/SettingsAgentsSection";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings";
import { deferred } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { stubSelectLayoutApis } from "./helpers/rendererTestEnvironment";

const bridgeMock = vi.hoisted(() => ({
  detectAgentTools: vi.fn(),
  detectWslEnvironment: vi.fn(),
  probeDesktopAgentCapabilities: vi.fn()
}));

vi.mock("../renderer/bridge", () => ({
  bridge: bridgeMock
}));

const t = createTranslator("en");
const canvasRef = { projectRoot: "/tmp/project", canvasId: "canvas-main" };
const ubuntuHost = { kind: "wsl", distribution: "Ubuntu" } as const;
const nativeHost = { kind: "native" } as const;
const initialSettings = mergeDesktopSettings(defaultDesktopSettings, {
  execution: { agentHost: ubuntuHost, agentTransport: "cli" }
});

function detectedCodex(executionHost: ExecutionHost, installed: boolean): DesktopAgentDetection {
  return {
    kind: "codex",
    runnerKind: "cli",
    executionHost,
    name: "Codex",
    command: "codex",
    versionArgs: ["--version"],
    execArgs: ["exec", "-"],
    fullAccessArgs: ["exec", "-"],
    installed,
    version: installed ? "codex 1.0.0" : null,
    unavailableReason: installed ? null : "not found"
  };
}

function renderSettings(
  saveDesktopSettings: PlanWeaveDesktopSettingsApi["saveDesktopSettings"],
  savedSettings = initialSettings,
  overrides?: Partial<PlanWeaveDesktopSettingsApi>
) {
  const settingsApi: PlanWeaveDesktopSettingsApi = {
    getDesktopSettings: vi.fn().mockResolvedValue(savedSettings),
    onAgentHostChanged: () => () => undefined,
    migrateLegacyDesktopSettings: vi.fn().mockResolvedValue(savedSettings),
    saveDesktopSettings,
    ...overrides
  };
  const setError = vi.fn();
  function SettingsHarness() {
    const current = useDesktopSettingsBridge({ settingsApi, setError });
    const detection = useDetectedAgents(
      current.settingsHydrated ? current.settings.execution.agentHost : null
    );
    return (
      <>
        <button type="button" onClick={() => current.updateSettings({ appearance: "dark" })}>
          Save appearance
        </button>
        <SettingsAgentsSection
          agentDetectionError={detection.agentDetectionError}
          agentDetectionRefreshing={detection.agentDetectionRefreshing}
          agents={detection.agentDetections}
          canvasRef={canvasRef}
          graph={graph}
          persistSettings={current.updateSettingsAndWait}
          refreshAgentDetections={detection.refreshAgentDetections}
          settings={current.settings}
          t={t}
          updateSettings={current.updateSettings}
        />
      </>
    );
  }
  render(<SettingsHarness />);
  return setError;
}

beforeEach(() => {
  stubSelectLayoutApis();
  bridgeMock.detectAgentTools.mockResolvedValue([detectedCodex(ubuntuHost, true)]);
  bridgeMock.detectWslEnvironment.mockResolvedValue({
    supported: true,
    available: true,
    distributions: ["Ubuntu"],
    unavailableReason: null
  });
});

afterEach(() => {
  cleanup();
  bridgeMock.detectAgentTools.mockReset();
  bridgeMock.detectWslEnvironment.mockReset();
  bridgeMock.probeDesktopAgentCapabilities.mockReset();
  resetAgentCapabilityProbeSessionCache();
});

describe("settings agents save failures", () => {
  it("keeps a probe through same-host settings reads and replaces it after batched cross-window host changes", async () => {
    const savedSettings = mergeDesktopSettings(initialSettings, {
      execution: { agentHost: nativeHost, agentTransport: "acp" }
    });
    let receiveHost: ((host: ExecutionHost) => void) | undefined;
    const getDesktopSettings = vi.fn(async () => structuredClone(savedSettings));
    const earlier = deferred<DesktopAgentCapabilityProbeResult>();
    const current = deferred<DesktopAgentCapabilityProbeResult>();
    bridgeMock.detectAgentTools.mockResolvedValue([
      { ...detectedCodex(nativeHost, true), runnerKind: "acp" }
    ]);
    bridgeMock.probeDesktopAgentCapabilities
      .mockReturnValueOnce(earlier.promise)
      .mockReturnValueOnce(current.promise);
    renderSettings(vi.fn(), savedSettings, {
      getDesktopSettings,
      onAgentHostChanged: (listener) => {
        receiveHost = listener;
        return () => {
          receiveHost = undefined;
        };
      }
    });

    await userEvent.click(await screen.findByRole("button", { name: "Codex options" }));
    expect(bridgeMock.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(getDesktopSettings).toHaveBeenCalledTimes(2);
    expect(bridgeMock.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(1);

    await act(async () => {
      receiveHost?.(ubuntuHost);
      receiveHost?.(nativeHost);
    });
    expect(bridgeMock.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(2);
    await act(() =>
      current.resolve({
        agentKind: "codex",
        executionHost: nativeHost,
        ok: true,
        message: "Ready",
        failureCode: null,
        agentInfo: null,
        authentication: { status: "not_advertised" },
        capabilities: [],
        checks: [],
        sessionConfig: {
          modes: null,
          configOptions: [
            {
              id: "native",
              type: "boolean",
              name: "Current native option",
              description: null,
              currentValue: false
            }
          ]
        }
      })
    );
    await act(() => earlier.reject(new Error("Previous Native capability failed")));
    expect(screen.getByRole("switch", { name: "Current native option" })).toBeVisible();
    expect(screen.queryByText("Previous Native capability failed")).not.toBeInTheDocument();
  });

  it("hides confirmed Native evidence while choosing or saving WSL and restores it on cancel or failure", async () => {
    const save = deferred<typeof initialSettings>();
    const persistSettings = vi.fn(() => save.promise);
    bridgeMock.detectAgentTools.mockResolvedValue([detectedCodex(nativeHost, true)]);
    renderSettings(
      persistSettings,
      mergeDesktopSettings(initialSettings, {
        execution: { agentHost: nativeHost }
      })
    );
    const hostSelect = await screen.findByRole("combobox", { name: "Agent host" });
    const nativeVersion = await screen.findByText(/codex 1\.0\.0/);
    const preflight = screen.getByTestId("settings-executor-preflight");

    const chooseWsl = async () => {
      await userEvent.click(hostSelect);
      await userEvent.click(screen.getByRole("option", { name: "WSL", exact: true }));
      expect(screen.getByRole("combobox", { name: "WSL distribution" })).toHaveTextContent(
        "Select a distribution"
      );
      expect(nativeVersion).not.toBeVisible();
      expect(preflight).not.toBeVisible();
    };
    await chooseWsl();
    expect(persistSettings).not.toHaveBeenCalled();
    await userEvent.click(hostSelect);
    await userEvent.click(screen.getByRole("option", { name: "Windows Native" }));
    expect(nativeVersion).toBeVisible();
    expect(preflight).toBeVisible();

    await chooseWsl();
    await userEvent.click(screen.getByRole("combobox", { name: "WSL distribution" }));
    await userEvent.click(screen.getByRole("option", { name: "Ubuntu" }));
    expect(hostSelect).toBeDisabled();
    expect(nativeVersion).not.toBeVisible();
    expect(preflight).not.toBeVisible();
    await act(() => save.reject(new Error("settings save failed")));
    expect(hostSelect).toHaveTextContent("Windows Native");
    expect(nativeVersion).toBeVisible();
    expect(preflight).toBeVisible();
    expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(1);
  });

  it("does not refresh detections after a failed host save and restores the control", async () => {
    const save = deferred<typeof initialSettings>();
    const persistSettings = vi.fn(() => save.promise);
    const setError = renderSettings(persistSettings);
    const hostSelect = await screen.findByRole("combobox", { name: "Agent host" });
    const executorSelect = screen.getByRole("combobox", { name: "Executor profile" });
    await waitFor(() => expect(executorSelect).toHaveTextContent("codex"));
    await userEvent.click(hostSelect);
    await userEvent.click(screen.getByRole("option", { name: "Windows Native" }));

    expect(hostSelect).toBeDisabled();
    expect(hostSelect).toHaveTextContent("WSL");
    expect(persistSettings).toHaveBeenCalledExactlyOnceWith({
      execution: { agentHost: nativeHost }
    });
    expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(1);

    await act(() => save.reject(new Error("settings save failed")));
    expect(setError).toHaveBeenCalledExactlyOnceWith("settings save failed");
    expect(hostSelect).toBeEnabled();
    expect(hostSelect).toHaveTextContent("WSL");
    expect(executorSelect).toBeEnabled();
    expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(1);
  });

  it("starts one new detection on the confirmed host even with a later settings save queued", async () => {
    const hostSave = deferred<typeof initialSettings>();
    const appearanceSave = deferred<typeof initialSettings>();
    const nextDetection = deferred<DesktopAgentDetection[]>();
    bridgeMock.detectAgentTools
      .mockResolvedValueOnce([detectedCodex(ubuntuHost, false)])
      .mockReturnValueOnce(nextDetection.promise);
    const persistSettings = vi
      .fn<PlanWeaveDesktopSettingsApi["saveDesktopSettings"]>()
      .mockReturnValueOnce(hostSave.promise)
      .mockReturnValueOnce(appearanceSave.promise);
    renderSettings(persistSettings);

    const hostSelect = await screen.findByRole("combobox", { name: "Agent host" });
    const executorSelect = screen.getByRole("combobox", { name: "Executor profile" });
    await waitFor(() => expect(executorSelect).toBeDisabled());
    await userEvent.click(hostSelect);
    await userEvent.click(screen.getByRole("option", { name: "Windows Native" }));
    await userEvent.click(screen.getByRole("button", { name: "Save appearance" }));
    expect(persistSettings).toHaveBeenCalledTimes(1);
    expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(1);
    expect(executorSelect).toBeDisabled();

    const confirmed = mergeDesktopSettings(initialSettings, {
      execution: { agentHost: nativeHost }
    });
    await act(() => hostSave.resolve(confirmed));

    expect(persistSettings).toHaveBeenNthCalledWith(2, { appearance: "dark" });
    expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(2);
    expect(hostSelect).toHaveTextContent("Windows Native");
    expect(screen.getByRole("button", { name: t("agentRefreshing") })).toBeDisabled();
    expect(executorSelect).toBeEnabled();

    await act(() => nextDetection.resolve([detectedCodex(nativeHost, true)]));
    await act(() =>
      appearanceSave.resolve(mergeDesktopSettings(confirmed, { appearance: "dark" }))
    );
    expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(2);
    expect(executorSelect).toHaveTextContent("codex");
    await userEvent.click(executorSelect);
    expect(screen.getByRole("option", { name: "codex" })).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("shows a startup detection failure and recovers through the Settings refresh control", async () => {
    bridgeMock.detectAgentTools.mockRejectedValueOnce(
      new Error("agent detection failed at startup")
    );
    renderSettings(vi.fn());

    expect(await screen.findByRole("alert")).toHaveTextContent("agent detection failed at startup");
    await userEvent.click(screen.getByRole("button", { name: t("agentRefresh") }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(bridgeMock.detectAgentTools).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("combobox", { name: "Executor profile" })).toHaveTextContent("codex");
  });
});
