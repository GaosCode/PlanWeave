/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers";
import { useAppViewHistory } from "../renderer/hooks/useAppViewHistory";
import { useTaskWorkspaceController } from "../renderer/task-workspace/useTaskWorkspaceController";
import { deferred } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { controllerApi } from "./helpers/taskWorkspaceControllerHarness";

afterEach(() => {
  cleanupRendererTestEnvironment();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  window.history.replaceState(null, "", "/");
});

/**
 * A workspace load that settles after the tree is gone must not touch React state.
 *
 * The request counter only rejects stale *requests*: it still equals the in-flight request
 * after unmount, so the rejection used to reach `setWorkspaceLoad`. React then reads
 * `window` while resolving the update priority; in CI the renderer environment had already
 * been torn down, so that read threw `ReferenceError: window is not defined` as an
 * unhandled rejection and failed the unit job even though all 4400 assertions had passed.
 */
it("ignores a workspace load that settles after unmount", async () => {
  // Trusting the package executors is irrelevant here and costs a PATH scan per test.
  const { root, init } = await createTestWorkspace(basicManifest(), {
    trustPackageExecutors: false
  });
  const runs = deferred<never>();
  const base = controllerApi({ readModel: () => null }).api;
  const api: typeof base = {
    ...base,
    listTaskWorkspaceRuns: vi.fn<typeof base.listTaskWorkspaceRuns>(() => runs.promise)
  };
  let openTask!: () => void;
  function App() {
    const [, , history] = useAppViewHistory("graph");
    openTask = () =>
      history.openTaskWorkspace(
        { projectRoot: root, canvasId: "default", taskId: "T-001" },
        { view: "graph" }
      );
    useTaskWorkspaceController({
      agentEndpointCatalog: [],
      agentEndpointPreferences: {},
      api,
      history,
      promptAuthority: {
        workspaceRoot: null,
        projectRoot: root,
        canvasLocator: { kind: "local", projectId: init.workspace.id, canvasId: "default" }
      },
      selectedWorkspaceRoot: null,
      saveAgentEndpointPreference: async () => undefined
    });
    return null;
  }

  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const view = render(<App />);
    act(() => openTask());
    await waitFor(() => expect(api.listTaskWorkspaceRuns).toHaveBeenCalled());
    view.unmount();
    /**
     * Stand in for the torn-down renderer environment: any state update dispatched from here
     * on throws inside React's update-priority resolution, exactly as it did in CI.
     */
    vi.stubGlobal("window", undefined);
    runs.reject(new Error("bridge unavailable after teardown"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
    vi.unstubAllGlobals();
  }
  // Scaffolding a real workspace costs >10s on Windows checkouts; the default budget is not enough there.
}, 30_000);
