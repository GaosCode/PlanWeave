/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopGraphDiagnostics } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import {
  deferred,
  project,
  projectSnapshot,
  projectDiagnostics
} from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";

afterEach(cleanupRendererTestEnvironment);

function failedSnapshot(parts: string[]) {
  return projectSnapshot({
    diagnostics: parts.map((path) => ({
      code: "desktop_snapshot_part_failed",
      path,
      message: `${path} failure`
    })),
    errors: parts.map((path) => `${path}: ${path} failure`)
  });
}

async function mountProject(bridge: ReturnType<typeof createDesktopBridgeMock>) {
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
  const setError = vi.fn();
  const t = createTranslator("en");
  const updateSettings = vi.fn();
  const hook = renderHook(() =>
    useDesktopProject({ planweaveHome: "", setError, t, updateSettings })
  );
  await waitFor(() => expect(hook.result.current.projectLoading).toBe(false));
  return { ...hook, setError };
}

describe("snapshot diagnostics ownership", () => {
  it.each([
    "graph",
    "derived",
    "layout"
  ])("only reports still-owned failures after %s refresh", async (writer) => {
    const pending = deferred<ReturnType<typeof projectSnapshot>>();
    const latestGraph = { ...graph, graphVersion: "latest" };
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot: vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(projectSnapshot({ graph: latestGraph })),
      getGraphViewModel: vi.fn().mockResolvedValue(latestGraph)
    });
    const { result, setError } = await mountProject(bridge);
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadProject(project);
    });
    await act(async () => {
      if (writer === "graph") await result.current.refreshGraph();
      else await result.current.refreshProjectDerivedState({ includeLayout: writer === "layout" });
    });
    setError.mockClear();
    await act(async () => {
      pending.resolve({
        ...failedSnapshot(["graph", "layout", "projectPromptMarkdown", "todoGroups"]),
        graph: null
      });
      await loading;
    });
    const expectedParts =
      writer === "graph"
        ? ["layout", "projectPromptMarkdown", "todoGroups"]
        : writer === "derived"
          ? ["layout", "projectPromptMarkdown"]
          : ["projectPromptMarkdown"];
    expect(result.current.graph).toBe(latestGraph);
    expect(result.current.projectDiagnostics.map((issue) => issue.path)).toEqual(expectedParts);
    expect(setError).toHaveBeenCalledExactlyOnceWith(
      expectedParts.map((part) => `${part}: ${part} failure`).join("\n")
    );
  });

  it.each([
    "load",
    "derived"
  ])("rechecks error ownership after %s waits for graph diagnostics", async (entry) => {
    const pendingDiagnostics = deferred<DesktopGraphDiagnostics>();
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot())
    });
    const { result, setError } = await mountProject(bridge);
    await act(async () => {
      await result.current.loadProject(project);
    });
    vi.mocked(bridge.getDesktopProjectSnapshot).mockResolvedValueOnce(failedSnapshot(["layout"]));
    vi.mocked(bridge.getDesktopGraphDiagnostics).mockReturnValueOnce(pendingDiagnostics.promise);
    let oldRequest!: Promise<void>;
    await act(async () => {
      oldRequest =
        entry === "load"
          ? result.current.loadProject(project)
          : result.current.refreshProjectDerivedState({ includeLayout: true });
    });
    const latestDiagnostic = {
      code: "desktop_snapshot_part_failed",
      path: "layout",
      message: "current layout failure"
    };
    vi.mocked(bridge.getDesktopProjectSnapshot).mockResolvedValueOnce(
      projectSnapshot({
        diagnostics: [latestDiagnostic],
        errors: ["layout: current layout failure"]
      })
    );
    await act(async () => {
      await result.current.refreshProjectDerivedState({ includeLayout: true });
    });
    expect(setError).toHaveBeenLastCalledWith("layout: current layout failure");
    setError.mockClear();
    await act(async () => {
      pendingDiagnostics.resolve(projectDiagnostics());
      await oldRequest;
    });
    expect(setError).not.toHaveBeenCalled();
    expect(result.current.projectDiagnostics).toEqual([latestDiagnostic]);
  });
});
