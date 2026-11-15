/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopAgentDetection, ExecutionHost } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { deferred, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { useVisibleGraphTasks } from "../renderer/hooks/useVisibleGraphTasks";
import { buildExecutorOptionViews } from "../renderer/executors/executorOptionViewModel";
import { createTranslator } from "../renderer/i18n";

afterEach(cleanupRendererTestEnvironment);

const nativeHost: ExecutionHost = { kind: "native" };
const ubuntuHost: ExecutionHost = { kind: "wsl", distribution: "Ubuntu" };
const debianHost: ExecutionHost = { kind: "wsl", distribution: "Debian" };

function codexDetection(installed: boolean, executionHost = nativeHost): DesktopAgentDetection {
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

async function mountAgentDetection(
  detectAgentTools: () => Promise<DesktopAgentDetection[]>,
  host: ExecutionHost
) {
  vi.stubGlobal("planweave", createDesktopBridgeMock({ detectAgentTools }));
  vi.resetModules();
  const { useDetectedAgents } = await import("../renderer/hooks/useDetectedAgents");
  return renderHook(({ host }) => useDetectedAgents(host), { initialProps: { host } });
}

function codexOption(agentDetections: DesktopAgentDetection[]) {
  const [option] = buildExecutorOptionViews({ executorOptions: ["codex"], agentDetections });
  return option;
}

describe("desktop agent detection request ownership", () => {
  it.each([
    { older: "startup", newestSettlesFirst: false },
    { older: "startup", newestSettlesFirst: true },
    { older: "refresh", newestSettlesFirst: false },
    { older: "refresh", newestSettlesFirst: true }
  ])("owns results and busy state after $older is superseded (newest settles first: $newestSettlesFirst)", async ({
    older,
    newestSettlesFirst
  }) => {
    const olderRequest = deferred<DesktopAgentDetection[]>();
    const newestRequest = deferred<DesktopAgentDetection[]>();
    const detect = vi.fn<() => Promise<DesktopAgentDetection[]>>();
    if (older === "refresh") detect.mockResolvedValueOnce([codexDetection(true)]);
    detect.mockReturnValueOnce(olderRequest.promise).mockReturnValueOnce(newestRequest.promise);
    const { result } = await mountAgentDetection(detect, nativeHost);
    if (older === "refresh") {
      await waitFor(() => expect(result.current.agentDetectionRefreshing).toBe(false));
    }
    const olderPublished = vi.fn();
    const newestPublished = vi.fn();
    act(() => {
      if (older === "refresh") void result.current.refreshAgentDetections(olderPublished);
      void result.current.refreshAgentDetections(newestPublished);
    });

    const installed = [codexDetection(true)];
    if (newestSettlesFirst) {
      await act(() => newestRequest.resolve(installed));
      expect(result.current.agentDetectionRefreshing).toBe(false);
    }
    await act(() => olderRequest.resolve([codexDetection(false)]));
    expect(result.current.agentDetectionRefreshing).toBe(!newestSettlesFirst);
    expect(codexOption(result.current.agentDetections)?.disabled).toBe(false);
    expect(olderPublished).not.toHaveBeenCalled();

    if (!newestSettlesFirst) await act(() => newestRequest.resolve(installed));
    expect(result.current.agentDetectionRefreshing).toBe(false);
    expect(codexOption(result.current.agentDetections)).toMatchObject({
      detected: true,
      disabled: false
    });
    expect(newestPublished).toHaveBeenCalledExactlyOnceWith(installed);
  });

  it.each([
    { from: "native", oldHost: nativeHost, to: "Ubuntu", newHost: ubuntuHost },
    { from: "Ubuntu", oldHost: ubuntuHost, to: "native", newHost: nativeHost },
    { from: "Ubuntu", oldHost: ubuntuHost, to: "Debian", newHost: debianHost }
  ])("hides the $from snapshot while detecting $to and ignores a late $from error", async ({
    oldHost,
    newHost
  }) => {
    const older = deferred<DesktopAgentDetection[]>();
    const newer = deferred<DesktopAgentDetection[]>();
    const detect = vi
      .fn<() => Promise<DesktopAgentDetection[]>>()
      .mockResolvedValueOnce([codexDetection(false, oldHost)])
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const { result, rerender } = await mountAgentDetection(detect, oldHost);
    await waitFor(() => expect(codexOption(result.current.agentDetections)?.disabled).toBe(true));

    act(() => {
      void result.current.refreshAgentDetections();
    });
    rerender({ host: newHost });
    expect(detect).toHaveBeenCalledTimes(3);
    expect(result.current.agentDetectionRefreshing).toBe(true);
    expect(codexOption(result.current.agentDetections)).toMatchObject({
      detected: null,
      disabled: false
    });

    await act(() => newer.resolve([codexDetection(true, newHost)]));
    await act(() => older.reject(new Error("obsolete host failed")));
    expect(result.current.agentDetectionRefreshing).toBe(false);
    expect(result.current.agentDetectionError).toBeNull();
    expect(result.current.agentDetections.map((detection) => detection.executionHost)).toEqual([
      newHost
    ]);
    expect(codexOption(result.current.agentDetections)).toMatchObject({
      detected: true,
      disabled: false
    });
  });

  it("keeps the newest failure visible when an older detection succeeds and recovers on retry", async () => {
    const startup = deferred<DesktopAgentDetection[]>();
    const failed = deferred<DesktopAgentDetection[]>();
    const detect = vi
      .fn<() => Promise<DesktopAgentDetection[]>>()
      .mockReturnValueOnce(startup.promise)
      .mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce([codexDetection(true)]);
    const { result } = await mountAgentDetection(detect, nativeHost);

    const published = vi.fn();
    act(() => {
      void result.current.refreshAgentDetections(published);
    });
    await act(() => failed.reject(new Error("newest detection failed")));
    await act(() => startup.resolve([codexDetection(true)]));
    expect(result.current.agentDetectionError).toBe("newest detection failed");
    expect(result.current.agentDetectionRefreshing).toBe(false);
    expect(result.current.agentDetections).toEqual([]);
    expect(published).not.toHaveBeenCalled();

    await act(() => result.current.refreshAgentDetections(published));
    expect(result.current.agentDetectionError).toBeNull();
    expect(codexOption(result.current.agentDetections)).toMatchObject({
      detected: true,
      disabled: false
    });
    expect(published).toHaveBeenCalledTimes(1);
  });

  it("discards a response whose host differs from the current WSL distribution", async () => {
    const detect = vi
      .fn<() => Promise<DesktopAgentDetection[]>>()
      .mockResolvedValueOnce([codexDetection(false, ubuntuHost)]);
    const { result } = await mountAgentDetection(detect, debianHost);

    await waitFor(() =>
      expect(result.current.agentDetectionError).toMatch(/different execution host/)
    );
    expect(codexOption(result.current.agentDetections)).toMatchObject({
      detected: null,
      disabled: false
    });
    expect(result.current.agentDetectionRefreshing).toBe(false);
  });

  it("retires the pending refresh when the hook unmounts and allows a fresh mount", async () => {
    const pending = deferred<DesktopAgentDetection[]>();
    const detect = vi
      .fn<() => Promise<DesktopAgentDetection[]>>()
      .mockResolvedValueOnce([codexDetection(true)])
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([codexDetection(true)]);
    const { result, unmount } = await mountAgentDetection(detect, nativeHost);
    await waitFor(() => expect(result.current.agentDetectionRefreshing).toBe(false));

    const published = vi.fn();
    act(() => {
      void result.current.refreshAgentDetections(published);
    });
    unmount();
    const reopened = await mountAgentDetection(detect, nativeHost);
    await waitFor(() =>
      expect(codexOption(reopened.result.current.agentDetections)?.detected).toBe(true)
    );
    await act(() => pending.resolve([codexDetection(false)]));
    expect(published).not.toHaveBeenCalled();
    expect(codexOption(reopened.result.current.agentDetections)).toMatchObject({
      detected: true,
      disabled: false
    });
  });
});

describe("desktop renderer hook interfaces", () => {
  it("returns detected agent tools without deriving project executor options", async () => {
    const bridge = createDesktopBridgeMock({
      detectAgentTools: vi.fn().mockResolvedValue([
        {
          kind: "claude-code",
          runnerKind: "cli",
          executionHost: nativeHost,
          name: "Claude Code",
          command: "claude",
          versionArgs: ["--version"],
          execArgs: ["-p"],
          fullAccessArgs: ["--dangerously-skip-permissions", "-p"],
          installed: true,
          version: "claude 1.0.0",
          unavailableReason: null
        },
        {
          kind: "opencode",
          runnerKind: "cli",
          executionHost: nativeHost,
          name: "OpenCode",
          command: "opencode",
          versionArgs: ["--version"],
          execArgs: ["run", "-"],
          fullAccessArgs: ["run", "--auto", "-"],
          installed: true,
          version: "opencode 1.0.0",
          unavailableReason: null
        },
        {
          kind: "pi",
          runnerKind: "cli",
          executionHost: nativeHost,
          name: "Pi",
          command: "pi",
          versionArgs: ["--version"],
          execArgs: ["-p"],
          fullAccessArgs: ["-p"],
          installed: false,
          version: null,
          unavailableReason: "not found"
        }
      ])
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDetectedAgents } = await import("../renderer/hooks/useDetectedAgents");

    const { result } = renderHook(() => useDetectedAgents(nativeHost));

    await waitFor(() =>
      expect(result.current.agentDetections.map((agent) => agent.kind)).toEqual([
        "claude-code",
        "opencode",
        "pi"
      ])
    );
    expect(result.current).not.toHaveProperty("executorOptions");
  });

  it("filters visible graph tasks only by search query", () => {
    const { result, rerender } = renderHook(({ query }) => useVisibleGraphTasks(graph, query), {
      initialProps: { query: "" }
    });

    expect([...result.current.visibleTaskIds]).toEqual(["T-ALPHA", "T-BETA"]);

    rerender({ query: "alpha" });

    expect(result.current.visibleTasks?.map((task) => task.taskId)).toEqual(["T-ALPHA"]);
    expect([...result.current.visibleTaskIds]).toEqual(["T-ALPHA"]);
  });

  it("keeps useDesktopProject as a compatible facade for project loading state", async () => {
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    const updateSettings = vi.fn();
    const { result } = renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings
      })
    );

    await waitFor(() => expect(result.current.selectedProject?.projectId).toBe(project.projectId));

    expect(result.current.graph?.graphVersion).toBe(graph.graphVersion);
    expect(result.current.selectedCanvasId).toBe("canvas-main");
    expect(result.current).toEqual(
      expect.objectContaining({
        loadProject: expect.any(Function),
        refreshProjectDerivedState: expect.any(Function),
        refreshRuntimeState: expect.any(Function),
        rollbackPendingImportRecovery: expect.any(Function),
        updateProjectPrompt: expect.any(Function)
      })
    );
    expect(updateSettings).toHaveBeenCalledWith({ runtimePath: project.workspaceRoot });
  });

  it("keeps Local project restoration off the collaboration bridge", async () => {
    const projectsResult = deferred<(typeof project)[]>();
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn(() => projectsResult.promise),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");

    renderHook(() =>
      useDesktopProject({
        planweaveHome: "",
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings: vi.fn()
      })
    );

    await waitFor(() => expect(bridge.listProjects).toHaveBeenCalledOnce());

    projectsResult.resolve([project]);
    await waitFor(() => expect(bridge.getDesktopProjectSnapshot).toHaveBeenCalled());
  });
});
