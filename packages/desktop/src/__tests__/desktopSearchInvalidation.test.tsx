/* @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  DesktopPackageFileChangeEvent,
  DesktopRuntimeStateChangeEvent,
  DesktopSearchProjection
} from "@planweave-ai/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";

const project = {
  projectId: "P",
  name: "Project",
  rootPath: "/tmp/search",
  workspaceRoot: "/tmp/search",
  activeCanvasId: "main",
  taskCanvases: []
};
const projection = (title: string): DesktopSearchProjection => ({
  diagnostics: [],
  results: [{ kind: "task", ref: "T-1", title, excerpt: title }]
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function advance(ms = 300) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const watchLeases: Array<{ retire: () => void }> = [];

async function setup() {
  vi.useFakeTimers();
  let packageChanged!: (event: DesktopPackageFileChangeEvent) => void;
  let runtimeChanged!: (event: DesktopRuntimeStateChangeEvent) => void;
  const search = vi.fn().mockResolvedValue(projection("alpha old"));
  const bridge = createDesktopBridgeMock({
    searchProjectWithDiagnostics: search,
    onPackageFileChanged: (listener) => {
      packageChanged = listener;
      return () => {};
    },
    onRuntimeStateChanged: (listener) => {
      runtimeChanged = listener;
      return () => {};
    }
  });
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  const { useSearchController } = await import("../renderer/controllers/SearchController");
  const { beginDesktopWatchRegistration } = await import("../renderer/desktopWatchRegistration");
  const mainWatch = beginDesktopWatchRegistration(project, "main");
  const otherCanvasWatch = beginDesktopWatchRegistration(project, "other");
  const otherProjectWatch = beginDesktopWatchRegistration(
    { rootPath: "/tmp/other", workspaceRoot: "/tmp/other" },
    "main"
  );
  watchLeases.push(mainWatch, otherCanvasWatch, otherProjectWatch);
  const args = {
    enabled: true,
    packageFingerprint: "original",
    selectedProject: project,
    selectedCanvasId: "main",
    openRunWorkspace: vi.fn(),
    openTaskWorkspace: vi.fn(),
    setError: vi.fn()
  };
  const hook = renderHook((props) => useSearchController(props), { initialProps: args });
  act(() => hook.result.current.setSearchQuery("alpha"));
  await advance();
  return {
    ...hook,
    args,
    search,
    packageChange: (canvasId = "main", projectRoot = project.rootPath) => {
      const reference = [mainWatch, otherCanvasWatch, otherProjectWatch]
        .map((lease) => lease.reference)
        .find((scope) => scope.projectRoot === projectRoot && scope.canvasId === canvasId);
      if (!reference) throw new Error("Expected a registered package event scope.");
      packageChanged({
        ...reference,
        paths: ["package/nodes/T-1/blocks/B-1.prompt.md"],
        triggeredAt: "2026-09-28T00:00:00Z"
      });
    },
    runtimeChange: () =>
      runtimeChanged({
        ...mainWatch.reference,
        stateFile: "/tmp/search/state.json",
        changedAt: "2026-09-28T00:00:00Z"
      })
  };
}
afterEach(() => {
  cleanup();
  for (const lease of watchLeases.splice(0)) lease.retire();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("requeries unchanged text through controller content events, coalesces bursts and filters canvas/project", async () => {
  const h = await setup();
  expect(h.search).toHaveBeenCalledTimes(2);
  act(() => h.result.current.setSearchCanvasScope("current"));
  await advance();
  h.search.mockClear();
  act(() => {
    h.packageChange("other");
    h.packageChange("main", "/tmp/other");
  });
  await advance();
  expect(h.search).not.toHaveBeenCalled();
  h.search.mockResolvedValue(projection("alpha edited prompt"));
  act(() => {
    h.packageChange();
    h.packageChange();
    h.runtimeChange();
  });
  await advance();
  expect(h.search).toHaveBeenCalledTimes(2);
  expect(h.result.current.searchResults[0]?.title).toBe("alpha edited prompt");
  expect(h.search.mock.calls[1]?.[2]).toMatchObject({ canvasId: "main", includeBodies: true });
  act(() => h.result.current.setSearchCanvasScope("all"));
  await advance();
  h.search.mockClear();
  h.search.mockResolvedValue(projection("alpha other canvas"));
  act(() => h.packageChange("other"));
  await advance();
  expect(h.search).toHaveBeenCalledTimes(2);
  expect(h.result.current.searchResults[0]?.title).toBe("alpha other canvas");
});
it("refreshes a changed content hash, ignores identical rerenders and pauses hidden queries until latest input returns", async () => {
  const h = await setup();
  h.search.mockClear();
  h.rerender({ ...h.args });
  await advance();
  expect(h.search).not.toHaveBeenCalled();
  h.search.mockResolvedValue(projection("alpha renamed"));
  h.rerender({ ...h.args, packageFingerprint: "edited" });
  await advance();
  expect(h.search).toHaveBeenCalledTimes(2);
  expect(h.result.current.searchResults[0]?.title).toBe("alpha renamed");
  h.rerender({ ...h.args, enabled: false });
  h.search.mockClear();
  act(() => {
    h.packageChange();
    h.runtimeChange();
    h.result.current.setSearchQuery("beta");
  });
  await advance();
  expect(h.search).not.toHaveBeenCalled();
  h.search.mockResolvedValue(projection("beta new report"));
  h.rerender({ ...h.args, enabled: true });
  await advance();
  expect(h.search).toHaveBeenCalledTimes(2);
  expect(h.search.mock.calls[0]?.[1]).toBe("beta");
  act(() => h.result.current.setSearchQuery(""));
  h.search.mockClear();
  act(() => h.runtimeChange());
  await advance();
  expect(h.search).not.toHaveBeenCalled();
});
it.each([
  "summary",
  "body",
  "error"
])("ignores stale %s after a content event and retries the same query", async (stage) => {
  const h = await setup();
  const old = deferred<DesktopSearchProjection>();
  if (stage === "body") h.search.mockResolvedValueOnce(projection("alpha old summary"));
  h.search.mockImplementationOnce(() => old.promise);
  act(() => h.packageChange());
  await advance();
  h.search.mockResolvedValue(projection("alpha fresh report"));
  act(() => h.runtimeChange());
  await advance();
  await act(async () => {
    if (stage === "error") old.reject(new Error("stale failure"));
    else old.resolve(projection("alpha stale"));
  });
  expect(h.result.current.searchResults[0]?.title).toBe("alpha fresh report");
  expect(h.args.setError).not.toHaveBeenCalled();
  h.search.mockRejectedValueOnce(new Error("current failure"));
  act(() => h.runtimeChange());
  await advance();
  expect(h.result.current.searchStatus.phase).toBe("error");
  h.search.mockResolvedValue(projection("alpha recovered"));
  h.rerender({ ...h.args, enabled: false });
  h.rerender(h.args);
  await advance();
  expect(h.result.current.searchResults[0]?.title).toBe("alpha recovered");
});

it("refreshes on window visibility return without scanning hidden events", async () => {
  const h = await setup();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  h.search.mockClear();
  act(() => h.runtimeChange());
  await advance();
  expect(h.search).not.toHaveBeenCalled();
  h.search.mockResolvedValue(projection("alpha report while hidden"));
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await advance();
  expect(h.search).toHaveBeenCalledTimes(2);
  expect(h.result.current.searchResults[0]?.title).toBe("alpha report while hidden");
});

it("does not publish a late old-project error after switching projects", async () => {
  const h = await setup();
  const old = deferred<DesktopSearchProjection>();
  h.search.mockImplementationOnce(() => old.promise);
  act(() => h.runtimeChange());
  await advance();
  h.search.mockResolvedValue(projection("alpha project B"));
  h.rerender({
    ...h.args,
    selectedProject: { ...project, projectId: "B", rootPath: "/tmp/project-b" }
  });
  await advance();
  await act(async () => old.reject(new Error("project A failure")));
  expect(h.result.current.searchResults[0]?.title).toBe("alpha project B");
  expect(h.args.setError).not.toHaveBeenCalled();
});
