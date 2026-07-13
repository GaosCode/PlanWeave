/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "../renderer/views/WorkspaceTabs";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const useProjectWorkspace = vi.hoisted(() => vi.fn());

vi.mock("../renderer/ProjectWorkspaceProvider", () => ({ useProjectWorkspace }));
vi.mock("../renderer/views/GraphView", () => ({
  GraphView: () => <div data-testid="graph-route">Graph route</div>
}));

afterEach(cleanupRendererTestEnvironment);

describe("Task Workspace route wiring", () => {
  it("renders the explicit Task Workspace route without falling back to Graph chrome", () => {
    useProjectWorkspace.mockReturnValue({
      shell: {
        activeView: "task-workspace",
        t: (key: string) => key
      },
      taskWorkspace: {
        error: null,
        navigation: {
          projectRoot: "/projects/demo",
          canvasId: "canvas-main",
          taskId: "T-001",
          source: { view: "graph" }
        },
        status: "loading"
      }
    });

    const { container } = render(<WorkspaceTabs />);

    expect(screen.getByRole("heading", { name: "taskWorkspaceLoading" })).toBeInTheDocument();
    expect(screen.queryByTestId("graph-route")).not.toBeInTheDocument();
    expect(container.querySelector(".app-drag-region")).not.toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass("rounded-l-xl");
  });
});
