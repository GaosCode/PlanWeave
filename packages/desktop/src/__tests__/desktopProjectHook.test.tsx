/* @vitest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { useVisibleGraphTasks } from "../renderer/hooks/useVisibleGraphTasks";
import { createTranslator } from "../renderer/i18n";

afterEach(cleanupRendererTestEnvironment);

describe("desktop renderer hook interfaces", () => {
  it("returns detected agent tools without deriving project executor options", async () => {
    const bridge = createDesktopBridgeMock({
      detectAgentTools: vi.fn().mockResolvedValue([
        {
          kind: "claude-code",
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

    const { result } = renderHook(() => useDetectedAgents());

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
        setError: vi.fn(),
        t: createTranslator("en"),
        updateSettings
      })
    );

    await waitFor(() => expect(result.current.selectedProject?.projectId).toBe(project.projectId));

    expect(result.current.graph?.graphVersion).toBe(projectSnapshot().graph.graphVersion);
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
});
