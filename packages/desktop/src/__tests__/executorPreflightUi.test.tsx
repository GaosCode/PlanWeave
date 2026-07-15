/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DesktopAgentDetection,
  DesktopAutoRunState,
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopTaskDetail,
  ExecutorPreflightResult
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";
import { SettingsAgentsSection } from "../renderer/settings/SettingsAgentsSection";
import { BlockInspector } from "../renderer/inspector/BlockInspector";
import { TaskInspector } from "../renderer/inspector/TaskInspector";
import { FloatingAutoRunControl } from "../renderer/run/FloatingAutoRunControl";

const bridgeMock = vi.hoisted(() => ({
  api: {
    probeDesktopAgentCapabilities: vi.fn(),
    testExecutorProfile: vi.fn()
  }
}));

vi.mock("../renderer/bridge", () => ({
  bridge: bridgeMock.api,
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

function graphWithExecutors(
  executorOptions: string[],
  patch: Partial<DesktopGraphViewModel> = {}
): DesktopGraphViewModel {
  return {
    ...graph,
    executorOptions,
    ...patch
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

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

function acpAgent(kind: DesktopAgentDetection["kind"], name: string): DesktopAgentDetection {
  return {
    runnerKind: "acp",
    kind,
    name,
    command: `${kind}-acp`,
    versionArgs: ["--version"],
    execArgs: [],
    fullAccessArgs: [],
    installed: true,
    version: "1.0.0",
    unavailableReason: null
  };
}

const preflightResult: ExecutorPreflightResult = {
  name: "codex",
  adapter: "codex-exec",
  profileAdapter: "agent",
  executionIntegration: "codex-exec",
  ok: false,
  message: "Command 'codex' could not be started: missing",
  checks: [
    {
      check: "profile_exists",
      status: "passed",
      message: "Executor profile 'codex' exists."
    },
    {
      check: "command_started",
      status: "failed",
      message: "Command 'codex' could not be started: missing",
      command: "codex",
      cwd: "/tmp/project"
    }
  ]
};

const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Project",
  rootPath: "/tmp/project",
  workspaceRoot: "/tmp/.planweave/project",
  activeCanvasId: "canvas-main",
  taskCanvases: []
};

function blockDetail(patch: Partial<DesktopBlockDetail> = {}): DesktopBlockDetail {
  return {
    ref: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    type: "implementation",
    title: "Implement",
    status: "ready",
    executor: "codex",
    effectiveExecutor: "codex",
    promptMarkdown: "# Prompt",
    promptMissing: false,
    promptSurfaceMarkdown: "# Effective",
    promptSources: [],
    dependencies: [],
    latestRunId: null,
    latestReviewAttemptId: null,
    activeFeedbackId: null,
    exceptionReason: null,
    reviewGate: null,
    ...patch
  };
}

function taskDetail(patch: Partial<DesktopTaskDetail> = {}): DesktopTaskDetail {
  return {
    taskId: "T-001",
    graphVersion: "pgv-test",
    title: "Task",
    status: "ready",
    executor: null,
    promptMarkdown: "# Task",
    promptHash: "hash",
    promptMissing: false,
    acceptance: [],
    blockOrder: [],
    ...patch
  };
}

function autoRunState(): DesktopAutoRunState {
  return {
    runId: "RUN-001",
    runSessionId: "SESSION-001",
    projectRoot: project.rootPath,
    canvasId: "canvas-main",
    scope: { kind: "project" },
    phase: "running",
    stepCount: 1,
    stepLimit: 20,
    currentRef: "T-001#B-001",
    currentExecutor: "codex",
    elapsedMs: 100,
    latestOutputSummary: null,
    latestRecordId: null,
    latestRecordPath: null,
    explanation: {
      phase: "running",
      currentRef: "T-001#B-001",
      currentExecutor: "codex",
      latestRecordId: null,
      latestRecordPath: null,
      latestOutputSummary: null,
      error: null,
      nextAction: {
        kind: "wait",
        message: "Wait for the current Auto Run step to finish.",
        command: null,
        targetPath: null,
        ref: "T-001#B-001"
      }
    },
    statePath: "/tmp/state.json",
    eventLogPath: "/tmp/events.jsonl",
    options: { tmuxEnabled: false },
    error: null,
    startedAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:01.000Z"
  };
}

afterEach(() => {
  cleanup();
  bridgeMock.api.probeDesktopAgentCapabilities.mockReset();
  bridgeMock.api.testExecutorProfile.mockReset();
});

describe("executor preflight desktop UI", () => {
  it("shows only detections for the selected agent transport", () => {
    const detections = [
      {
        runnerKind: "cli" as const,
        kind: "codex" as const,
        name: "Codex CLI",
        command: "codex",
        versionArgs: ["--version"],
        execArgs: ["exec", "-"],
        fullAccessArgs: ["exec", "--sandbox", "danger-full-access", "-"],
        installed: true,
        version: "1.0.0",
        unavailableReason: null
      },
      {
        runnerKind: "acp" as const,
        kind: "codex" as const,
        name: "Codex ACP",
        command: "codex-acp",
        versionArgs: ["--version"],
        execArgs: [],
        fullAccessArgs: [],
        installed: true,
        version: "1.0.0",
        unavailableReason: null
      }
    ];
    const props = {
      agentDetectionRefreshing: false,
      agents: detections,
      canvasRef,
      graph,
      refreshAgentDetections: vi.fn().mockResolvedValue(undefined),
      t,
      updateSettings: vi.fn()
    };
    const { rerender } = render(
      <SettingsAgentsSection
        {...props}
        settings={{
          ...defaultDesktopSettings,
          execution: { ...defaultDesktopSettings.execution, agentTransport: "cli" }
        }}
      />
    );

    expect(screen.getByText("Codex CLI")).toBeInTheDocument();
    expect(screen.queryByText("Codex ACP")).not.toBeInTheDocument();

    rerender(
      <SettingsAgentsSection
        {...props}
        settings={{
          ...defaultDesktopSettings,
          execution: { ...defaultDesktopSettings.execution, agentTransport: "acp" }
        }}
      />
    );

    expect(screen.getByText("Codex ACP")).toBeInTheDocument();
    expect(screen.queryByText("Codex CLI")).not.toBeInTheDocument();
  });

  it("renders and persists only ACP options advertised by preflight", async () => {
    installSelectDomStubs();
    bridgeMock.api.probeDesktopAgentCapabilities.mockResolvedValue({
      agentKind: "codex",
      ok: true,
      message: "ACP capability probe passed.",
      failureCode: null,
      agentInfo: { name: "Codex ACP", version: "1.0.0" },
      authentication: { status: "not_advertised" },
      capabilities: ["session"],
      sessionConfig: {
        modes: null,
        configOptions: [
          {
            id: "model",
            type: "select",
            name: "Model",
            description: null,
            category: "model",
            currentValue: "gpt-5",
            options: [
              { value: "gpt-5", name: "GPT-5", description: null, group: null },
              { value: "gpt-5.2-codex", name: "GPT-5.2 Codex", description: null, group: null }
            ]
          },
          {
            id: "mode",
            type: "select",
            name: "Mode",
            description: null,
            category: "mode",
            currentValue: "build",
            options: [
              { value: "build", name: "Build", description: null, group: null },
              { value: "plan", name: "Plan", description: null, group: null }
            ]
          }
        ]
      }
    });
    const updateSettings = vi.fn();
    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[
          {
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
          }
        ]}
        canvasRef={canvasRef}
        graph={graph}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={updateSettings}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Codex ACP options" }));
    expect(bridgeMock.api.probeDesktopAgentCapabilities).toHaveBeenCalledWith({
      agentKind: "codex",
      projectRoot: canvasRef.projectRoot
    });
    await screen.findByRole("combobox", { name: "Model" });
    await userEvent.click(screen.getByRole("combobox", { name: "Model" }));
    await userEvent.click(screen.getByRole("option", { name: "GPT-5.2 Codex" }));

    const update = updateSettings.mock.calls.at(-1)?.[0];
    expect(typeof update).toBe("function");
    expect(update(defaultDesktopSettings)).toMatchObject({
      agents: { codex: { acp: { configOptions: { model: "gpt-5.2-codex" } } } }
    });
    expect(screen.getByRole("combobox", { name: "Mode" })).toBeInTheDocument();
    expect(screen.getByText(t("acpPermissionsManaged"))).toBeInTheDocument();
  });

  it.each([
    {
      kind: "codex" as const,
      agentName: "Codex ACP",
      optionId: "reasoning_effort",
      optionName: "Reasoning effort",
      firstValue: "low",
      firstLabel: "Low",
      currentValue: "high",
      currentLabel: "High"
    },
    {
      kind: "pi" as const,
      agentName: "Pi ACP",
      optionId: "thought_level",
      optionName: "Thought level",
      firstValue: "minimal",
      firstLabel: "Minimal",
      currentValue: "medium",
      currentLabel: "Medium"
    },
    {
      kind: "opencode" as const,
      agentName: "OpenCode ACP",
      optionId: "reasoning",
      optionName: "Reasoning",
      firstValue: "fast",
      firstLabel: "Fast",
      currentValue: "balanced",
      currentLabel: "Balanced"
    }
  ])("shows and persists $kind thinking options from advertised values", async ({
    kind,
    agentName,
    optionId,
    optionName,
    firstValue,
    firstLabel,
    currentValue,
    currentLabel
  }) => {
    installSelectDomStubs();
    bridgeMock.api.probeDesktopAgentCapabilities.mockResolvedValue({
      agentKind: kind,
      ok: true,
      message: "ACP capability probe passed.",
      failureCode: null,
      agentInfo: { name: agentName, version: "1.0.0" },
      authentication: { status: "not_advertised" },
      capabilities: ["session"],
      sessionConfig: {
        modes: null,
        configOptions: [
          {
            id: optionId,
            type: "select",
            name: optionName,
            description: null,
            category: null,
            currentValue,
            options: [
              { value: firstValue, name: firstLabel, description: null, group: null },
              { value: currentValue, name: currentLabel, description: null, group: null }
            ]
          }
        ]
      }
    });
    const updateSettings = vi.fn();
    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[acpAgent(kind, agentName)]}
        canvasRef={canvasRef}
        graph={graphWithExecutors([kind])}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={updateSettings}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: `${agentName} options` }));
    const select = await screen.findByRole("combobox", { name: optionName });
    expect(select).toHaveTextContent(currentLabel);
    expect(select).not.toHaveTextContent(firstLabel);

    await userEvent.click(select);
    await userEvent.click(screen.getByRole("option", { name: firstLabel }));

    const update = updateSettings.mock.calls.at(-1)?.[0];
    expect(typeof update).toBe("function");
    expect(update(defaultDesktopSettings)).toMatchObject({
      agents: { [kind]: { acp: { configOptions: { [optionId]: firstValue } } } }
    });
  });

  it("shows Pi's advertised current session mode and persists an explicit override", async () => {
    installSelectDomStubs();
    bridgeMock.api.probeDesktopAgentCapabilities.mockResolvedValue({
      agentKind: "pi",
      ok: true,
      message: "ACP capability probe passed.",
      failureCode: null,
      agentInfo: { name: "Pi ACP", version: "1.0.0" },
      authentication: { status: "not_advertised" },
      capabilities: ["session"],
      sessionConfig: {
        modes: {
          currentModeId: "thinking",
          availableModes: [
            { id: "default", name: "Default", description: null },
            { id: "thinking", name: "Thinking", description: null }
          ]
        },
        configOptions: []
      }
    });
    const updateSettings = vi.fn();
    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[acpAgent("pi", "Pi ACP")]}
        canvasRef={canvasRef}
        graph={graphWithExecutors(["pi"])}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={updateSettings}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Pi ACP options" }));
    const select = await screen.findByRole("combobox", { name: "Session mode" });
    expect(select).toHaveTextContent("Thinking");
    expect(select).not.toHaveTextContent("Default");

    await userEvent.click(select);
    await userEvent.click(screen.getByRole("option", { name: "Default" }));

    const update = updateSettings.mock.calls.at(-1)?.[0];
    expect(typeof update).toBe("function");
    expect(update(defaultDesktopSettings)).toMatchObject({
      agents: { pi: { acp: { modeId: "default" } } }
    });
  });

  it("probes each expanded ACP agent independently and shows an inline failure", async () => {
    bridgeMock.api.probeDesktopAgentCapabilities.mockImplementation(
      async ({ agentKind }: { agentKind: string }) => ({
        agentKind,
        ok: agentKind === "codex",
        message:
          agentKind === "codex" ? "Codex capability probe passed." : "OpenCode ACP unavailable.",
        failureCode: agentKind === "codex" ? null : "initialization_failed",
        agentInfo: null,
        authentication: agentKind === "codex" ? { status: "not_advertised" } : null,
        capabilities: agentKind === "codex" ? ["session"] : null,
        sessionConfig: agentKind === "codex" ? { modes: null, configOptions: [] } : null
      })
    );

    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[
          {
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
          },
          {
            runnerKind: "acp",
            kind: "opencode",
            name: "OpenCode ACP",
            command: "opencode",
            versionArgs: ["--version"],
            execArgs: [],
            fullAccessArgs: [],
            installed: true,
            version: "1.0.0",
            unavailableReason: null
          }
        ]}
        canvasRef={canvasRef}
        graph={graphWithExecutors(["codex", "opencode"])}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Codex ACP options" }));
    await waitFor(() =>
      expect(bridgeMock.api.probeDesktopAgentCapabilities).toHaveBeenCalledWith({
        agentKind: "codex",
        projectRoot: canvasRef.projectRoot
      })
    );
    await userEvent.click(screen.getByRole("button", { name: "OpenCode ACP options" }));

    expect(await screen.findByText("OpenCode ACP unavailable.")).toBeInTheDocument();
    expect(bridgeMock.api.probeDesktopAgentCapabilities).toHaveBeenCalledWith({
      agentKind: "opencode",
      projectRoot: canvasRef.projectRoot
    });
    expect(bridgeMock.api.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(2);
  });

  it("retries a failed ACP capability probe after collapsing and reopening the agent", async () => {
    bridgeMock.api.probeDesktopAgentCapabilities
      .mockResolvedValueOnce({
        agentKind: "codex",
        ok: false,
        message: "Authentication required.",
        failureCode: "auth_required",
        agentInfo: null,
        authentication: {
          status: "action_required",
          reason: "no_safe_method",
          methods: []
        },
        capabilities: ["authentication"],
        sessionConfig: null
      })
      .mockResolvedValueOnce({
        agentKind: "codex",
        ok: true,
        message: "ACP capability probe passed.",
        failureCode: null,
        agentInfo: { name: "Codex ACP", version: "1.0.0" },
        authentication: { status: "not_advertised" },
        capabilities: ["session"],
        sessionConfig: {
          modes: null,
          configOptions: [
            {
              id: "model",
              type: "select",
              name: "Model",
              description: null,
              category: "model",
              currentValue: "gpt-5",
              options: [{ value: "gpt-5", name: "GPT-5", description: null, group: null }]
            }
          ]
        }
      });

    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[
          {
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
          }
        ]}
        graph={null}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={vi.fn()}
      />
    );

    const optionsButton = screen.getByRole("button", { name: "Codex ACP options" });
    await userEvent.click(optionsButton);
    expect(await screen.findByText("Authentication required.")).toBeInTheDocument();
    await userEvent.click(optionsButton);
    await userEvent.click(optionsButton);

    expect(await screen.findByRole("combobox", { name: "Model" })).toBeInTheDocument();
    expect(bridgeMock.api.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(2);
  });

  it("clears successful capability probes after agent detection refresh without probing twice", async () => {
    bridgeMock.api.probeDesktopAgentCapabilities.mockResolvedValue({
      agentKind: "codex",
      ok: true,
      message: "ACP capability probe passed.",
      failureCode: null,
      agentInfo: null,
      authentication: { status: "not_advertised" },
      capabilities: ["session"],
      sessionConfig: { modes: null, configOptions: [] }
    });
    const refreshAgentDetections = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[
          {
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
          }
        ]}
        graph={null}
        refreshAgentDetections={refreshAgentDetections}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={vi.fn()}
      />
    );

    const optionsButton = screen.getByRole("button", { name: "Codex ACP options" });
    await userEvent.click(optionsButton);
    await screen.findByText(t("acpModelManaged"));
    await userEvent.click(optionsButton);
    await userEvent.click(optionsButton);
    expect(bridgeMock.api.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: t("agentRefresh") }));
    await waitFor(() => expect(refreshAgentDetections).toHaveBeenCalledTimes(1));
    await screen.findByText(t("acpNotProbed"));
    expect(bridgeMock.api.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(1);
    await userEvent.click(optionsButton);
    await userEvent.click(optionsButton);
    await waitFor(() =>
      expect(bridgeMock.api.probeDesktopAgentCapabilities).toHaveBeenCalledTimes(2)
    );
  });

  it("probes ACP capabilities without a graph or canvas", async () => {
    bridgeMock.api.probeDesktopAgentCapabilities.mockResolvedValue({
      agentKind: "codex",
      ok: true,
      message: "ACP capability probe passed.",
      failureCode: null,
      agentInfo: { name: "Codex ACP", version: "1.0.0" },
      authentication: { status: "not_advertised" },
      capabilities: ["session"],
      sessionConfig: { modes: null, configOptions: [] }
    });

    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[
          {
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
          }
        ]}
        graph={null}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Codex ACP options" }));

    await waitFor(() =>
      expect(bridgeMock.api.probeDesktopAgentCapabilities).toHaveBeenCalledWith({
        agentKind: "codex",
        projectRoot: null
      })
    );
    expect(await screen.findByText(t("acpModelManaged"))).toBeInTheDocument();
  });

  it("runs selected graph executor preflight from settings and renders the full check list", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue(preflightResult);

    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[]}
        canvasRef={canvasRef}
        graph={graph}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("settings-run-executor-preflight"));

    expect(bridgeMock.api.testExecutorProfile).toHaveBeenCalledWith(canvasRef, "codex");
    expect(await screen.findByTestId("executor-preflight-checks")).toHaveTextContent(
      "profile_exists"
    );
    expect(screen.getByTestId("executor-preflight-checks")).toHaveTextContent("command_started");
    expect(screen.getAllByText(/Command 'codex' could not be started/).length).toBeGreaterThan(0);
  });

  it("clears cached settings preflight results when the agent transport changes", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue({
      ...preflightResult,
      message: "CLI preflight result"
    });
    const props = {
      agentDetectionRefreshing: false,
      agents: [],
      canvasRef,
      graph,
      refreshAgentDetections: vi.fn().mockResolvedValue(undefined),
      t,
      updateSettings: vi.fn()
    };
    const { rerender } = render(
      <SettingsAgentsSection
        {...props}
        settings={{
          ...defaultDesktopSettings,
          execution: { ...defaultDesktopSettings.execution, agentTransport: "cli" }
        }}
      />
    );

    await userEvent.click(screen.getByTestId("settings-run-executor-preflight"));
    expect(await screen.findByText(/CLI preflight result/)).toBeInTheDocument();

    rerender(
      <SettingsAgentsSection
        {...props}
        settings={{
          ...defaultDesktopSettings,
          execution: { ...defaultDesktopSettings.execution, agentTransport: "acp" }
        }}
      />
    );

    expect(screen.queryByText(/CLI preflight result/)).not.toBeInTheDocument();
  });

  it("ignores stale executor preflight responses after the selected graph executor changes", async () => {
    const codex = deferred<ExecutorPreflightResult>();
    const opencode = deferred<ExecutorPreflightResult>();
    bridgeMock.api.testExecutorProfile.mockImplementation((_ref: unknown, executorName: unknown) =>
      executorName === "codex" ? codex.promise : opencode.promise
    );

    const { rerender } = render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[]}
        canvasRef={canvasRef}
        graph={graphWithExecutors(["codex"])}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("settings-run-executor-preflight"));
    rerender(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[]}
        canvasRef={canvasRef}
        graph={graphWithExecutors(["opencode"], {
          graphVersion: "pgv-next",
          packageFingerprint: "pkg-next"
        })}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={vi.fn()}
      />
    );
    codex.resolve({
      ...preflightResult,
      name: "codex",
      ok: true,
      message: "stale codex preflight passed",
      checks: []
    });
    await act(async () => {
      await codex.promise;
    });

    expect(screen.queryByText("stale codex preflight passed")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("settings-run-executor-preflight"));
    opencode.resolve({
      ...preflightResult,
      name: "opencode",
      ok: true,
      message: "opencode preflight passed",
      checks: []
    });
    await act(async () => {
      await opencode.promise;
    });

    expect(screen.getByText(/opencode preflight passed/)).toBeInTheDocument();
  });

  it("tests inherited effective block executors without treating inherit as an executor name", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue({
      ...preflightResult,
      ok: true,
      message: "executor preflight passed"
    });

    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        canvasRef={canvasRef}
        error={null}
        executorOptions={["codex"]}
        graph={graph}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={blockDetail({ executor: null, effectiveExecutor: "codex" })}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByText("Inherit: codex")).toBeInTheDocument();
    expect(screen.getByTestId("block-executor-preflight")).toHaveAccessibleName("Test preflight");
    expect(screen.getByTestId("block-executor-preflight")).not.toHaveTextContent("Test preflight");
    await userEvent.click(screen.getByTestId("block-executor-preflight"));

    expect(bridgeMock.api.testExecutorProfile).toHaveBeenCalledWith(canvasRef, "codex");
    expect(await screen.findByTestId("block-executor-preflight-status")).toHaveTextContent(
      "Preflight passed"
    );
  });

  it("preflights an explicit legacy ACP block profile without changing its identity", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue(preflightResult);

    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        canvasRef={canvasRef}
        error={null}
        executorOptions={["codex"]}
        graph={graphWithExecutors(["codex"], { agentTransport: "cli" })}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={blockDetail({ executor: "codex-acp", effectiveExecutor: "codex-acp" })}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("codex");
    await userEvent.click(screen.getByTestId("block-executor-preflight"));
    expect(bridgeMock.api.testExecutorProfile).toHaveBeenCalledWith(canvasRef, "codex-acp");
  });

  it("keeps a package executor literal when its name overlaps a builtin ACP alias", () => {
    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        canvasRef={canvasRef}
        error={null}
        executorOptions={["codex-acp"]}
        graph={graphWithExecutors(["codex-acp"], {
          packageExecutorNames: ["codex-acp"]
        })}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={blockDetail({ executor: "codex-acp", effectiveExecutor: "codex-acp" })}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("codex-acp");
  });

  it("preflights an explicit legacy ACP task profile without changing its identity", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue(preflightResult);

    render(
      <TaskInspector
        canvasRef={canvasRef}
        error={null}
        executorOptions={["codex"]}
        graph={graphWithExecutors(["codex"], { agentTransport: "cli" })}
        onClose={vi.fn()}
        saveSelectedTaskExecutor={vi.fn()}
        saveSelectedTaskPrompt={vi.fn()}
        saveSelectedTaskTitle={vi.fn()}
        selectedTask={taskDetail({ executor: "codex-acp" })}
        setSelectedTask={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("codex");
    await userEvent.click(screen.getByTestId("task-executor-preflight"));
    expect(bridgeMock.api.testExecutorProfile).toHaveBeenCalledWith(canvasRef, "codex-acp");
  });

  it("does not preflight a task executor inferred from renderer fallback defaults", () => {
    render(
      <TaskInspector
        canvasRef={canvasRef}
        error={null}
        executorOptions={["manual", "codex"]}
        graph={graphWithExecutors(["manual", "codex"])}
        onClose={vi.fn()}
        saveSelectedTaskExecutor={vi.fn()}
        saveSelectedTaskPrompt={vi.fn()}
        saveSelectedTaskTitle={vi.fn()}
        selectedTask={taskDetail({ executor: null })}
        setSelectedTask={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByTestId("task-executor-preflight")).toBeDisabled();
    expect(bridgeMock.api.testExecutorProfile).not.toHaveBeenCalled();
  });

  it("keeps Auto Run start available while executor preflight is only a manual diagnostic", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue(preflightResult);
    const handleAutoRunClick = vi.fn().mockResolvedValue(undefined);

    render(
      <FloatingAutoRunControl
        affectedTasks={[]}
        autoRunNextAction={null}
        autoRunRetrospective={null}
        autoRunScopeMode="project"
        autoRunState={autoRunState()}
        controlRef={vi.fn()}
        diagnostics={[]}
        projectDiagnostics={[]}
        dirtyPromptRefs={[]}
        dirtyPromptCount={0}
        autoRunPreflightExecutorHint="codex"
        handleAutoRunClick={handleAutoRunClick}
        handleAutoRunNextAction={vi.fn().mockResolvedValue(undefined)}
        handleRevealPathInFinder={vi.fn().mockResolvedValue(undefined)}
        miniRunPanelOpen={true}
        moveAutoRunControl={vi.fn()}
        onOpenFileSyncRef={vi.fn()}
        refreshPackageFiles={vi.fn().mockResolvedValue(undefined)}
        refreshedPromptCount={0}
        refreshConcurrency={null}
        resetRuntimeStateClick={vi.fn().mockResolvedValue(undefined)}
        selectedBlockPresent={true}
        selectedCanvasId="canvas-other"
        selectedProject={project}
        selectedTaskPanelId="T-001"
        setAutoRunScopeMode={vi.fn()}
        setMiniRunPanelOpen={vi.fn()}
        startAutoRunControlDrag={vi.fn()}
        stopAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        stopAutoRunControlDrag={vi.fn()}
        style={{ right: 24, bottom: 24 }}
        t={t}
      />
    );

    await userEvent.click(
      within(screen.getByTestId("auto-run-executor-preflight-section")).getByRole("button", {
        name: "Executor preflight"
      })
    );
    await userEvent.click(screen.getByTestId("auto-run-executor-preflight"));
    expect(bridgeMock.api.testExecutorProfile).toHaveBeenCalledWith(canvasRef, "codex");
    await waitFor(() =>
      expect(screen.getByTestId("auto-run-executor-preflight-status")).toHaveTextContent(
        "Preflight failed"
      )
    );
    expect(screen.getByTestId("auto-run-executor-preflight-status")).not.toHaveTextContent(
      preflightResult.message
    );
    expect(screen.queryByText(preflightResult.message)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Auto Run" }));
    expect(handleAutoRunClick).toHaveBeenCalledTimes(1);
  });

  it("runs startup executor preflight from the Auto Run panel with a runtime executor hint", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue({
      ...preflightResult,
      ok: true,
      message: "executor preflight passed"
    });

    render(
      <FloatingAutoRunControl
        affectedTasks={[]}
        autoRunNextAction={null}
        autoRunRetrospective={null}
        autoRunScopeMode="project"
        autoRunState={null}
        controlRef={vi.fn()}
        diagnostics={[]}
        projectDiagnostics={[]}
        dirtyPromptRefs={[]}
        dirtyPromptCount={0}
        autoRunPreflightExecutorHint="codex"
        handleAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        handleAutoRunNextAction={vi.fn().mockResolvedValue(undefined)}
        handleRevealPathInFinder={vi.fn().mockResolvedValue(undefined)}
        miniRunPanelOpen={true}
        moveAutoRunControl={vi.fn()}
        onOpenFileSyncRef={vi.fn()}
        refreshPackageFiles={vi.fn().mockResolvedValue(undefined)}
        refreshedPromptCount={0}
        refreshConcurrency={null}
        resetRuntimeStateClick={vi.fn().mockResolvedValue(undefined)}
        selectedBlockPresent={false}
        selectedCanvasId="canvas-main"
        selectedProject={project}
        selectedTaskPanelId={null}
        setAutoRunScopeMode={vi.fn()}
        setMiniRunPanelOpen={vi.fn()}
        startAutoRunControlDrag={vi.fn()}
        stopAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        stopAutoRunControlDrag={vi.fn()}
        style={{ right: 24, bottom: 24 }}
        t={t}
      />
    );

    expect(screen.getByTestId("auto-run-executor-preflight-section")).toHaveTextContent(
      "Executor preflight"
    );
    expect(screen.queryByText("codex")).not.toBeInTheDocument();
    await userEvent.click(
      within(screen.getByTestId("auto-run-executor-preflight-section")).getByRole("button", {
        name: "Executor preflight"
      })
    );
    expect(screen.getByText("codex")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("auto-run-executor-preflight"));

    expect(bridgeMock.api.testExecutorProfile).toHaveBeenCalledWith(canvasRef, "codex");
    await waitFor(() =>
      expect(screen.getByTestId("auto-run-executor-preflight-status")).toHaveTextContent(
        "Preflight passed"
      )
    );
  });
});
