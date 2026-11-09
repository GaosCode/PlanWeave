/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type * as React from "react";
import type { DesktopLayout } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDesktopLayout,
  resetDesktopLayout,
  resolveTaskCanvasWorkspace,
  saveDesktopLayout
} from "../../../runtime/src/desktop/index.js";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { deferred, project } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";
import type { AppFlowNode } from "../renderer/types";

afterEach(cleanupRendererTestEnvironment);

describe("layout intent persistence order", () => {
  it.each([
    ["save", "reset"],
    ["reset", "save"],
    ["save", "save"]
  ] as const)("persists the final intent for %s then %s", async (first, last) => {
    const { root, init } = await createTestWorkspace();
    const workspace = await resolveTaskCanvasWorkspace(root, "default");
    const initial = await getDesktopLayout(workspace);
    const releaseFirst = deferred<void>();
    const enteredFirst = deferred<void>();
    let calls = 0;
    let secondStartedEarly = false;
    let released = false;
    const orderedIo = async (write: () => Promise<DesktopLayout>) => {
      calls += 1;
      if (calls === 1) {
        enteredFirst.resolve();
        await releaseFirst.promise;
      } else if (!released) secondStartedEarly = true;
      return write();
    };
    const api = createDesktopBridgeMock({
      saveDesktopLayout: vi.fn((_reference, value) =>
        orderedIo(() => saveDesktopLayout(workspace, value))
      ),
      resetDesktopLayout: vi.fn(() => orderedIo(() => resetDesktopLayout(workspace)))
    });
    vi.stubGlobal("planweave", api);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const setLayout = vi.fn();
    const setError = vi.fn();
    const hook = renderHook(() =>
      useGraphPaletteActions({
        captureProjectSelection: () => ({ isCurrent: () => true }),
        flowInstance: null,
        graph,
        layout: initial,
        nodes: [{ id: "T-001", position: { x: 0, y: 0 } }] as AppFlowNode[],
        loadProject: vi.fn(),
        refreshProjectDerivedState: vi.fn(),
        selectedCanvasId: "default",
        selectedProject: {
          ...project,
          rootPath: root,
          workspaceRoot: init.workspace.workspaceRoot
        },
        selectedBlock: null,
        selectedTaskPanelId: null,
        setLayout,
        setError,
        selectTaskPanel: vi.fn(),
        settings: defaultDesktopSettings,
        t: createTranslator("en")
      })
    );
    const invoke = (kind: "save" | "reset", x: number) =>
      kind === "reset"
        ? hook.result.current.resetLayout()
        : hook.result.current.handleNodeDragStop({} as React.MouseEvent, {
            id: "T-001",
            position: { x, y: 180 },
            data: {}
          });
    let firstWrite!: Promise<void>;
    let lastWrite!: Promise<void>;
    act(() => {
      firstWrite = invoke(first, 120);
    });
    await enteredFirst.promise;
    act(() => {
      lastWrite = invoke(last, 900);
    });
    await act(async () => {
      released = true;
      releaseFirst.resolve();
      await Promise.all([firstWrite, lastWrite]);
    });
    expect(secondStartedEarly).toBe(false);
    expect(setError.mock.calls.filter(([message]) => message !== null)).toEqual([]);
    const reopened = await getDesktopLayout(await resolveTaskCanvasWorkspace(root, "default"));
    expect(reopened.nodes).toEqual(last === "reset" ? [] : [{ nodeId: "T-001", x: 900, y: 180 }]);
    expect(setLayout).toHaveBeenCalledTimes(1);
    expect(setLayout).toHaveBeenLastCalledWith(reopened);
  });
});
