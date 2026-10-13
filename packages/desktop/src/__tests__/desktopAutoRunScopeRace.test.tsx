/* @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import type {
  DesktopLatestAutoRunSummary,
  DesktopAutoRunState,
  DesktopBridgeApi
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { deferred, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { autoRunState, defaultAutoRunControlArgs } from "./helpers/autoRunControlHarness";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import type { AutoRunNextActionDescriptor } from "../renderer/run/autoRunNextActions";

afterEach(cleanupRendererTestEnvironment);

async function sessionHarness() {
  const bridge = createDesktopBridgeMock({
    listProjects: vi.fn().mockResolvedValue([]),
    getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
    getLatestAutoRunSummaryWithDiagnostics: vi.fn<
      DesktopBridgeApi["getLatestAutoRunSummaryWithDiagnostics"]
    >(async (ref) => ({
      state: autoRunState({
        projectRoot: ref.projectRoot,
        canvasId: ref.canvasId ?? null,
        runId: `RUN-${ref.projectRoot}-${ref.canvasId}`
      }),
      diagnostics: [{ code: `diag-${ref.canvasId}`, message: "Current" }]
    }))
  });
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
  const { useDesktopProjectSession } = await import("../renderer/hooks/useDesktopProjectSession");
  const setError = vi.fn();
  const { result, unmount } = renderHook(() => {
    const projectState = useDesktopProject({
      planweaveHome: "",
      autoSelectInitialProject: false,
      setError,
      t: createTranslator("en"),
      updateSettings: vi.fn()
    });
    return useDesktopProjectSession({
      projectState,
      language: "en",
      setError,
      clearSelectedBlockRecords: vi.fn(),
      selectBlock: vi.fn(),
      setActiveView: vi.fn(),
      setBlockInspectorOpen: vi.fn(),
      setSelectedBlock: vi.fn(),
      setSelectedRunRecord: vi.fn()
    });
  });
  await act(async () => {
    await result.current.openProject(project, "canvas-main", { recordCanvasSelection: false });
  });
  return { bridge, result, setError, unmount };
}

describe("Desktop Auto Run selection ownership", () => {
  it.each([
    "canvas",
    "project"
  ] as const)("discards a late summary and diagnostics after switching %s", async (kind) => {
    const h = await sessionHarness();
    const old = deferred<DesktopLatestAutoRunSummary>();
    vi.mocked(h.bridge.getLatestAutoRunSummaryWithDiagnostics).mockReturnValueOnce(old.promise);
    let request!: Promise<DesktopAutoRunState | null>;
    act(() => {
      request = h.result.current.refreshLatestAutoRunSummary();
    });
    const nextProject =
      kind === "project" ? { ...project, projectId: "P-B", rootPath: "/tmp/project-b" } : project;
    await act(async () => {
      await h.result.current.openProject(nextProject, "canvas-b", { recordCanvasSelection: false });
    });
    const expected = h.result.current.autoRunState;
    await act(async () => {
      old.resolve({
        state: autoRunState({ runId: "RUN-OLD" }),
        diagnostics: [{ code: "old", message: "Obsolete" }]
      });
      await request;
    });
    expect(h.result.current.autoRunState).toEqual(expected);
    expect(h.result.current.autoRunState?.canvasId).toBe("canvas-b");
    expect(h.result.current.autoRunDiagnostics).toEqual([
      { code: "diag-canvas-b", message: "Current" }
    ]);
  });

  it.each([
    "switch",
    "newer",
    "unmount"
  ] as const)("does not publish obsolete summary errors after %s", async (mode) => {
    const h = await sessionHarness();
    const old = deferred<DesktopLatestAutoRunSummary>();
    vi.mocked(h.bridge.getLatestAutoRunSummaryWithDiagnostics).mockReturnValueOnce(old.promise);
    let pending!: Promise<unknown>;
    act(() => {
      pending = h.result.current.refreshLatestAutoRunSummary().catch(() => undefined);
    });
    if (mode === "switch")
      await act(async () => {
        await h.result.current.openProject(project, "canvas-b", { recordCanvasSelection: false });
      });
    if (mode === "newer")
      await act(async () => {
        await h.result.current.refreshLatestAutoRunSummary();
      });
    if (mode === "unmount") h.unmount();
    h.setError.mockClear();
    await act(async () => {
      old.reject(new Error("OLD-SUMMARY"));
      await pending;
    });
    expect(h.setError).not.toHaveBeenCalled();
  });

  it("keeps the latest same-scope summary request and reports a current failure", async () => {
    const h = await sessionHarness();
    const old = deferred<DesktopLatestAutoRunSummary>();
    vi.mocked(h.bridge.getLatestAutoRunSummaryWithDiagnostics).mockReturnValueOnce(old.promise);
    let pending!: Promise<unknown>;
    act(() => {
      pending = h.result.current.refreshLatestAutoRunSummary();
    });
    await act(async () => {
      await h.result.current.refreshLatestAutoRunSummary();
    });
    const latest = h.result.current.autoRunState;
    await act(async () => {
      old.resolve({ state: autoRunState({ runId: "OLD-SAME" }), diagnostics: [] });
      await pending;
    });
    expect(h.result.current.autoRunState).toEqual(latest);
    vi.mocked(h.bridge.getLatestAutoRunSummaryWithDiagnostics).mockRejectedValueOnce(
      new Error("CURRENT-SUMMARY")
    );
    await act(async () => {
      await h.result.current.refreshLatestAutoRunSummary().catch(() => undefined);
    });
    expect(h.setError).toHaveBeenCalledWith("CURRENT-SUMMARY");
  });

  it("does not request summary after a discarded load completes", async () => {
    const h = await sessionHarness();
    const snapshot = deferred<ReturnType<typeof projectSnapshot>>();
    vi.mocked(h.bridge.getDesktopProjectSnapshot).mockReturnValueOnce(snapshot.promise);
    let loading!: Promise<void>;
    act(() => {
      loading = h.result.current.openProject(project, "canvas-a", { recordCanvasSelection: false });
    });
    await act(async () => {
      await h.result.current.openProject(project, "canvas-b", { recordCanvasSelection: false });
    });
    vi.mocked(h.bridge.getLatestAutoRunSummaryWithDiagnostics).mockClear();
    await act(async () => {
      snapshot.resolve(projectSnapshot());
      await loading;
    });
    expect(h.bridge.getLatestAutoRunSummaryWithDiagnostics).not.toHaveBeenCalled();
    expect(h.result.current.autoRunState?.canvasId).toBe("canvas-b");
  });

  it("keeps a newer summary when an earlier runtime refresh resolves", async () => {
    const h = await sessionHarness();
    const runtime = deferred<Awaited<ReturnType<typeof h.bridge.getDesktopRuntimeRefresh>>>();
    vi.mocked(h.bridge.getDesktopRuntimeRefresh).mockReturnValueOnce(runtime.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = h.result.current.refreshRuntimeState();
    });
    await act(async () => {
      await h.result.current.refreshLatestAutoRunSummary();
    });
    const expected = h.result.current.autoRunState;
    h.setError.mockClear();
    await act(async () => {
      runtime.resolve({
        latestAutoRun: autoRunState({ runId: "OLD-RUNTIME" }),
        diagnostics: [{ code: "old", message: "Old" }],
        errors: ["OLD-RUNTIME"]
      });
      await pending;
    });
    expect(h.result.current.autoRunState).toEqual(expected);
    expect(h.result.current.runtimeDiagnostics).toEqual([]);
    expect(h.setError).not.toHaveBeenCalled();
    expect(h.result.current.autoRunDiagnostics[0]?.code).toBe("diag-canvas-main");
    vi.mocked(h.bridge.getDesktopRuntimeRefresh).mockResolvedValue({
      latestAutoRun: autoRunState({ runId: "CURRENT-RUNTIME" }),
      diagnostics: [],
      errors: []
    });
    await act(async () => {
      await h.result.current.refreshRuntimeState();
    });
    expect(h.result.current.autoRunState?.runId).toBe("CURRENT-RUNTIME");
  });

  it.each([
    "pause",
    "resume",
    "stop"
  ] as const)("checks runtime run ownership before %s even when the cached scope looks current", async (command) => {
    const actual = autoRunState({
      runId: "RUN-A",
      canvasId: "canvas-a",
      phase: command === "resume" ? "paused" : "running"
    });
    const cached = { ...actual, canvasId: "canvas-b" };
    const bridge = createDesktopBridgeMock({
      getAutoRunState: vi.fn().mockResolvedValue(actual),
      pauseAutoRun: vi.fn().mockResolvedValue(actual),
      resumeAutoRun: vi.fn().mockResolvedValue(actual),
      stopAutoRun: vi.fn().mockResolvedValue(actual)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useAutoRunControl(
        defaultAutoRunControlArgs({
          autoRunState: cached,
          selectedProject: project,
          selectedCanvasId: "canvas-b",
          setError
        })
      )
    );
    await act(async () => {
      if (command === "stop") await result.current.stopAutoRunClick();
      else await result.current.handleAutoRunClick();
    });
    expect(bridge.pauseAutoRun).not.toHaveBeenCalled();
    expect(bridge.resumeAutoRun).not.toHaveBeenCalled();
    expect(bridge.stopAutoRun).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith("auto_run_scope_mismatch");
  });

  it.each([
    ["pause", false],
    ["resume", false],
    ["stop", false],
    ["pause", true],
    ["resume", true],
    ["stop", true]
  ] as const)("preserves valid local %s with Workspace locator %s", async (command, workspaceBound) => {
    const state = autoRunState({ phase: command === "resume" ? "paused" : "running" });
    const next = {
      ...state,
      phase:
        command === "pause"
          ? ("paused" as const)
          : command === "stop"
            ? ("stopped" as const)
            : ("running" as const)
    };
    const bridge = createDesktopBridgeMock({
      getAutoRunState: vi.fn().mockResolvedValue(state),
      pauseAutoRun: vi.fn().mockResolvedValue(next),
      resumeAutoRun: vi.fn().mockResolvedValue(next),
      stopAutoRun: vi.fn().mockResolvedValue(next)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");
    const setAutoRunState = vi.fn();
    const { result } = renderHook(() =>
      useAutoRunControl(
        defaultAutoRunControlArgs({
          autoRunState: state,
          selectedProject: project,
          canvasLocator: workspaceBound
            ? {
                kind: "workspace",
                connectionProfileId: "remote-1",
                workspaceId: workspaceIdSchema.parse("W-1"),
                projectId: "P-remote",
                canvasId: "canvas-main"
              }
            : undefined,
          setAutoRunState
        })
      )
    );
    await act(async () => {
      if (command === "stop") await result.current.stopAutoRunClick();
      else await result.current.handleAutoRunClick();
    });
    expect(bridge.getAutoRunState).toHaveBeenCalledWith(state.runId);
    expect(setAutoRunState).toHaveBeenCalledWith(next);
  });

  it("does not dispatch after a pending authority lookup changes scope or unmounts", async () => {
    const lookup = deferred<DesktopAutoRunState>();
    const state = autoRunState();
    const bridge = createDesktopBridgeMock({
      getAutoRunState: vi.fn().mockReturnValue(lookup.promise),
      pauseAutoRun: vi.fn().mockResolvedValue(state)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");
    const setError = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ canvas }) =>
        useAutoRunControl(
          defaultAutoRunControlArgs({
            autoRunState: state,
            selectedProject: project,
            selectedCanvasId: canvas,
            setError
          })
        ),
      { initialProps: { canvas: "canvas-main" } }
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleAutoRunClick();
    });
    rerender({ canvas: "canvas-b" });
    rerender({ canvas: "canvas-main" });
    unmount();
    await act(async () => {
      lookup.resolve(state);
      await pending;
    });
    expect(bridge.pauseAutoRun).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });
  it("preserves remote-only Endpoint stop while discarding an old remote lifecycle callback", async () => {
    const bridge = createDesktopBridgeMock();
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");
    type Starter = NonNullable<Parameters<typeof useAutoRunControl>[0]["startAutoRunScope"]>;
    let callbacks: Parameters<Starter>[2];
    const startAutoRunScope = vi.fn<Starter>(async (_scope, _local, lifecycle) => {
      callbacks = lifecycle;
    });
    const stopAutoRunScope = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ canvas }) =>
        useAutoRunControl(
          defaultAutoRunControlArgs({
            selectedProject: null,
            selectedCanvasId: canvas,
            canvasLocator: {
              kind: "workspace",
              connectionProfileId: "remote-1",
              workspaceId: workspaceIdSchema.parse("W-1"),
              projectId: "P-remote",
              canvasId: canvas
            },
            runtimeAvailability: { kind: "available" },
            startAutoRunScope,
            stopAutoRunScope
          })
        ),
      { initialProps: { canvas: "canvas-a" } }
    );
    await act(async () => {
      await result.current.handleAutoRunClick();
    });
    act(() => {
      callbacks?.onStarted?.();
    });
    expect(result.current.endpointScopeRunPhase).toBe("preparing");
    await act(async () => {
      await result.current.stopAutoRunClick();
    });
    expect(stopAutoRunScope).toHaveBeenCalledOnce();
    expect(bridge.getAutoRunState).not.toHaveBeenCalled();
    rerender({ canvas: "canvas-b" });
    act(() => {
      callbacks?.onFailed?.("OLD-REMOTE");
    });
    expect(result.current.endpointScopeRunPhase).toBeNull();
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("discards a late control %s after changing selection", async (mode) => {
    const state = autoRunState();
    const pendingControl = deferred<DesktopAutoRunState>();
    const bridge = createDesktopBridgeMock({
      getAutoRunState: vi.fn().mockResolvedValue(state),
      pauseAutoRun: vi.fn().mockReturnValue(pendingControl.promise)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");
    const setAutoRunState = vi.fn();
    const setError = vi.fn();
    const { result, rerender } = renderHook(
      ({ canvas }) =>
        useAutoRunControl(
          defaultAutoRunControlArgs({
            autoRunState: state,
            selectedProject: project,
            selectedCanvasId: canvas,
            setAutoRunState,
            setError
          })
        ),
      { initialProps: { canvas: "canvas-main" } }
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.handleAutoRunClick();
    });
    expect(bridge.pauseAutoRun).toHaveBeenCalledWith(state.runId, state.statePath);
    rerender({ canvas: "canvas-b" });
    await act(async () => {
      if (mode === "resolve") pendingControl.resolve({ ...state, phase: "paused" });
      else pendingControl.reject(new Error("OLD-CONTROL"));
      await pending;
    });
    expect(setAutoRunState).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });
});

const retryAction: AutoRunNextActionDescriptor = {
  command: "retry_ref",
  enabled: true,
  disabledReason: null,
  ref: "T-ALPHA#B-001",
  nextActionKind: "resolve_error",
  label: "Retry",
  message: "Retry the failed block.",
  recordId: null,
  targetPath: null,
  manualCommand: null
};

function resetReceipt(): Awaited<ReturnType<DesktopBridgeApi["resetRuntimeState"]>> {
  return {
    statePath: "/tmp/demo/state.json",
    reason: "Desktop reset requested.",
    forced: true,
    previousCurrentRefs: [],
    previousCurrentFeedbackId: null,
    previousCurrentReviewBlockRef: null,
    previousInProgressRefs: [],
    sessionId: "RESET-1",
    stoppedAutoRunIds: [],
    session: {
      stateVersion: 1,
      sessionId: "RESET-1",
      kind: "reset",
      trigger: "desktop",
      projectRoot: project.rootPath,
      canvasId: "canvas-a",
      scope: { kind: "project" },
      phase: "completed",
      startedAt: "2026-10-02T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      finishedAt: "2026-10-02T00:00:00Z",
      reset: null,
      autoRun: null,
      latestRecordId: null,
      latestRecordPath: null,
      workspaceExecution: null,
      error: null
    }
  };
}

async function mutationHarness(workspace = false) {
  const bridge = createDesktopBridgeMock({
    unblockBlock: vi.fn<DesktopBridgeApi["unblockBlock"]>().mockResolvedValue(undefined),
    startAutoRun: vi
      .fn<DesktopBridgeApi["startAutoRun"]>()
      .mockResolvedValue(autoRunState({ canvasId: "canvas-a" })),
    resetRuntimeState: vi
      .fn<DesktopBridgeApi["resetRuntimeState"]>()
      .mockResolvedValue(resetReceipt())
  });
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const { useAutoRunControl } = await import("../renderer/hooks/useAutoRunControl");
  const setError = vi.fn();
  const setAutoRunState = vi.fn();
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const resetWorkspaceRuntime = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const { result, rerender, unmount } = renderHook(
    ({ canvas, root }) =>
      useAutoRunControl(
        defaultAutoRunControlArgs({
          selectedProject: workspace ? null : { ...project, rootPath: root },
          selectedCanvasId: canvas,
          canvasLocator: workspace
            ? {
                kind: "workspace",
                connectionProfileId: "remote-1",
                workspaceId: workspaceIdSchema.parse("W-1"),
                projectId: root === project.rootPath ? "P-remote" : "P-other",
                canvasId: canvas
              }
            : undefined,
          resetWorkspaceRuntime,
          onAutoRunDerivedStateRefresh: refresh,
          setAutoRunState,
          setError
        })
      ),
    { initialProps: { canvas: "canvas-a", root: project.rootPath } }
  );
  return {
    bridge,
    result,
    rerender,
    unmount,
    setError,
    setAutoRunState,
    refresh,
    resetWorkspaceRuntime
  };
}

type MutationHarness = Awaited<ReturnType<typeof mutationHarness>>;
type MutationInvalidation = "canvas" | "project" | "roundtrip" | "unmount" | "newer";
function changeMutationSelection(h: MutationHarness, kind: Exclude<MutationInvalidation, "newer">) {
  if (kind === "unmount") h.unmount();
  else if (kind === "project") h.rerender({ root: "/tmp/project-b", canvas: "canvas-a" });
  else {
    h.rerender({ root: project.rootPath, canvas: "canvas-b" });
    if (kind === "roundtrip") h.rerender({ root: project.rootPath, canvas: "canvas-a" });
  }
}
const mutationInvalidations: MutationInvalidation[] = [
  "canvas",
  "project",
  "roundtrip",
  "unmount",
  "newer"
];

describe("Desktop runtime mutation continuations", () => {
  it.each(
    (["resolve", "reject"] as const).flatMap((mode) =>
      mutationInvalidations.map((kind) => [mode, kind] as const)
    )
  )("discards retry unblock %s after %s", async (mode, kind) => {
    const h = await mutationHarness();
    const old = deferred<void>();
    vi.mocked(h.bridge.unblockBlock).mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = h.result.current.handleAutoRunNextAction(retryAction);
    });
    expect(h.bridge.unblockBlock).toHaveBeenCalledOnce();
    if (kind === "newer")
      await act(async () => {
        await h.result.current.handleAutoRunNextAction(retryAction);
      });
    else changeMutationSelection(h, kind);
    vi.mocked(h.bridge.startAutoRun).mockClear();
    h.setAutoRunState.mockClear();
    h.setError.mockClear();
    await act(async () => {
      if (mode === "resolve") old.resolve();
      else old.reject(new Error("OLD-RETRY"));
      await pending;
    });
    expect(h.bridge.startAutoRun).not.toHaveBeenCalled();
    expect(h.setAutoRunState).not.toHaveBeenCalled();
    expect(h.setError).not.toHaveBeenCalled();
  });

  it("starts a current-scope retry after its unblock acknowledgement", async () => {
    const h = await mutationHarness();
    const unblock = deferred<void>();
    vi.mocked(h.bridge.unblockBlock).mockReturnValueOnce(unblock.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = h.result.current.handleAutoRunNextAction(retryAction);
    });
    expect(h.bridge.startAutoRun).not.toHaveBeenCalled();
    await act(async () => {
      unblock.resolve();
      await pending;
    });
    expect(h.bridge.startAutoRun).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-a" },
      { kind: "block", blockRef: retryAction.ref },
      20,
      { tmuxEnabled: false }
    );
    expect(h.setAutoRunState).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId: "canvas-a" })
    );
  });

  it.each(["unblock", "start"] as const)("reports a current retry %s error", async (stage) => {
    const h = await mutationHarness();
    if (stage === "unblock")
      vi.mocked(h.bridge.unblockBlock).mockRejectedValueOnce(new Error("CURRENT-RETRY"));
    else vi.mocked(h.bridge.startAutoRun).mockRejectedValueOnce(new Error("CURRENT-RETRY"));
    await act(async () => {
      await h.result.current.handleAutoRunNextAction(retryAction);
    });
    expect(h.setError).toHaveBeenCalledWith("CURRENT-RETRY");
  });

  it.each(
    (["local", "workspace"] as const).flatMap((owner) =>
      (["resolve", "reject"] as const).flatMap((mode) =>
        mutationInvalidations.map((kind) => [owner, mode, kind] as const)
      )
    )
  )("discards %s reset %s after %s", async (owner, mode, kind) => {
    const h = await mutationHarness(owner === "workspace");
    const old = deferred<void>();
    if (owner === "local")
      vi.mocked(h.bridge.resetRuntimeState).mockImplementationOnce(async () => {
        await old.promise;
        return resetReceipt();
      });
    else h.resetWorkspaceRuntime.mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = h.result.current.resetRuntimeStateClick();
    });
    expect(
      owner === "local" ? h.bridge.resetRuntimeState : h.resetWorkspaceRuntime
    ).toHaveBeenCalledOnce();
    if (kind === "newer")
      await act(async () => {
        await h.result.current.resetRuntimeStateClick();
      });
    else changeMutationSelection(h, kind);
    h.setAutoRunState.mockClear();
    h.refresh.mockClear();
    h.setError.mockClear();
    await act(async () => {
      if (mode === "resolve") old.resolve();
      else old.reject(new Error("OLD-RESET"));
      await pending;
    });
    expect(h.setAutoRunState).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.setError).not.toHaveBeenCalled();
  });

  it.each([
    "local",
    "workspace"
  ] as const)("publishes a current %s reset acknowledgement", async (owner) => {
    const h = await mutationHarness(owner === "workspace");
    await act(async () => {
      await h.result.current.resetRuntimeStateClick();
    });
    expect(h.setAutoRunState).toHaveBeenCalledWith(null);
    expect(h.refresh).toHaveBeenCalledTimes(owner === "local" ? 1 : 0);
    expect(h.setError).not.toHaveBeenCalled();
  });

  it.each(["local", "workspace"] as const)("reports a current %s reset error", async (owner) => {
    const h = await mutationHarness(owner === "workspace");
    if (owner === "local")
      vi.mocked(h.bridge.resetRuntimeState).mockRejectedValueOnce(new Error("CURRENT-RESET"));
    else h.resetWorkspaceRuntime.mockRejectedValueOnce(new Error("CURRENT-RESET"));
    await act(async () => {
      await h.result.current.resetRuntimeStateClick();
    });
    expect(h.setError).toHaveBeenCalledWith("CURRENT-RESET");
    expect(h.setAutoRunState).not.toHaveBeenCalled();
  });

  it("discards a local reset derived-refresh error after switching selection", async () => {
    const h = await mutationHarness();
    const refresh = deferred<void>();
    h.refresh.mockReturnValueOnce(refresh.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = h.result.current.resetRuntimeStateClick();
    });
    expect(h.refresh).toHaveBeenCalledOnce();
    h.rerender({ root: project.rootPath, canvas: "canvas-b" });
    h.setError.mockClear();
    await act(async () => {
      refresh.reject(new Error("OLD-REFRESH"));
      await pending;
    });
    expect(h.setError).not.toHaveBeenCalled();
  });
});

describe("Desktop retry/reset completed operation ownership", () => {
  it.each(
    (["resolve", "reject"] as const).flatMap((mode) =>
      (["canvas", "unmount", "newer"] as const).map((kind) => [mode, kind] as const)
    )
  )("discards retry start %s after %s", async (mode, kind) => {
    const h = await mutationHarness();
    const old = deferred<DesktopAutoRunState>();
    vi.mocked(h.bridge.startAutoRun).mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = h.result.current.handleAutoRunNextAction(retryAction);
    });
    expect(h.bridge.startAutoRun).toHaveBeenCalledOnce();
    if (kind === "newer")
      await act(async () => {
        await h.result.current.handleAutoRunNextAction(retryAction);
      });
    else changeMutationSelection(h, kind);
    h.setAutoRunState.mockClear();
    h.setError.mockClear();
    await act(async () => {
      if (mode === "resolve") old.resolve(autoRunState({ canvasId: "canvas-a" }));
      else old.reject(new Error("OLD-START"));
      await pending;
    });
    expect(h.setAutoRunState).not.toHaveBeenCalled();
    expect(h.setError).not.toHaveBeenCalled();
  });

  it.each([
    "retry",
    "reset"
  ] as const)("invalidates an old %s when the other mutation starts", async (oldKind) => {
    const h = await mutationHarness();
    const old = deferred<void>();
    if (oldKind === "retry") vi.mocked(h.bridge.unblockBlock).mockReturnValueOnce(old.promise);
    else
      vi.mocked(h.bridge.resetRuntimeState).mockImplementationOnce(async () => {
        await old.promise;
        return resetReceipt();
      });
    let pending!: Promise<void>;
    await act(async () => {
      pending =
        oldKind === "retry"
          ? h.result.current.handleAutoRunNextAction(retryAction)
          : h.result.current.resetRuntimeStateClick();
    });
    await act(async () => {
      if (oldKind === "retry") await h.result.current.resetRuntimeStateClick();
      else await h.result.current.handleAutoRunNextAction(retryAction);
    });
    vi.mocked(h.bridge.startAutoRun).mockClear();
    h.setAutoRunState.mockClear();
    h.refresh.mockClear();
    await act(async () => {
      old.resolve();
      await pending;
    });
    expect(h.bridge.startAutoRun).not.toHaveBeenCalled();
    expect(h.setAutoRunState).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
