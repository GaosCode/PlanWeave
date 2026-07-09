/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import {
  cleanupRendererTestEnvironment,
  stubSelectLayoutApis
} from "./helpers/rendererTestEnvironment";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    Background: () => <div data-testid="react-flow-background" />,
    Controls: () => <div data-testid="react-flow-controls" />,
    MiniMap: () => <div data-testid="react-flow-minimap" />,
    ReactFlow: (props: { children?: ReactNode; onInit?: (instance: unknown) => void }) => {
      React.useEffect(() => {
        props.onInit?.({ fitView: vi.fn() });
      }, [props.onInit]);
      return <div data-testid="react-flow">{props.children}</div>;
    },
    useEdgesState: (initialEdges: unknown[]) => {
      const [edges, setEdges] = React.useState(initialEdges);
      return [edges, setEdges, vi.fn()];
    },
    useNodesState: (initialNodes: unknown[]) => {
      const [nodes, setNodes] = React.useState(initialNodes);
      return [nodes, setNodes, vi.fn()];
    }
  };
});

afterEach(() => {
  cleanupRendererTestEnvironment();
});

describe("Auto Run diagnostics integration", () => {
  it("shows latest Auto Run summary diagnostics in the desktop diagnostics popover", async () => {
    stubSelectLayoutApis();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn()
      }))
    );
    const diagnostic = {
      code: "auto_run_state_invalid_json",
      message: "Auto Run state could not be parsed.",
      path: "/tmp/demo/.planweave/results/auto-runs/DESKTOP-RUN-0002/state.json"
    };
    const bridge = createDesktopBridgeMock({
      listProjects: vi.fn().mockResolvedValue([project]),
      getDesktopProjectSnapshot: vi.fn().mockResolvedValue(projectSnapshot()),
      refreshPackageFileChanges: vi
        .fn()
        .mockResolvedValue({ diagnostics: [], dirtyPromptRefs: [] }),
      watchPackageFiles: vi.fn().mockResolvedValue(undefined),
      getLatestAutoRunSummaryWithDiagnostics: vi.fn().mockResolvedValue({
        state: null,
        diagnostics: [diagnostic]
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.stubGlobal("planweaveDesktopSettings", {
      getDesktopSettings: vi.fn().mockResolvedValue({ ...defaultDesktopSettings, language: "en" }),
      migrateLegacyDesktopSettings: vi
        .fn()
        .mockResolvedValue({ ...defaultDesktopSettings, language: "en" }),
      saveDesktopSettings: vi.fn().mockResolvedValue({ ...defaultDesktopSettings, language: "en" })
    });
    vi.resetModules();
    const { App } = await import("../renderer/App");

    render(<App />);

    await waitFor(() =>
      expect(bridge.getLatestAutoRunSummaryWithDiagnostics).toHaveBeenCalledWith({
        projectRoot: project.rootPath,
        canvasId: "canvas-main"
      })
    );
    await userEvent.click(screen.getByRole("button", { name: "View desktop diagnostics" }));

    expect(screen.getByTestId("runtime-diagnostics-section")).toHaveTextContent(
      "Runtime diagnostics (1)"
    );
    expect(screen.getByTestId("desktop-runtime-diagnostic")).toHaveTextContent(
      "auto_run_state_invalid_json"
    );
    expect(screen.getByTestId("desktop-runtime-diagnostic")).toHaveTextContent(
      "Auto Run state could not be parsed."
    );
  });
});
