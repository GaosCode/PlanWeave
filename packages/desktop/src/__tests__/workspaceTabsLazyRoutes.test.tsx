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
vi.mock("../renderer/views/CanvasMapView", () => ({
  CanvasMapView: () => <div data-testid="canvas-map-route">Canvas map route</div>
}));
vi.mock("../renderer/views/NotificationsView", () => ({
  NotificationsView: () => <div data-testid="notifications-route">Notifications route</div>
}));
vi.mock("../renderer/views/ReviewPipelineView", () => ({
  ReviewPipelineView: () => <div data-testid="review-pipeline-route">Review pipeline route</div>
}));
vi.mock("../renderer/views/SearchView", () => ({
  SearchView: () => <div data-testid="search-route">Search route</div>
}));
vi.mock("../renderer/views/StatisticsView", () => ({
  StatisticsView: () => <div data-testid="statistics-route">Statistics route</div>
}));
vi.mock("../renderer/views/TodoView", () => ({
  TodoView: () => <div data-testid="todo-route">Todo route</div>
}));
vi.mock("../renderer/views/TaskWorkspaceAppRoute", () => ({
  TaskWorkspaceAppRoute: () => <div data-testid="task-workspace-route">Task workspace route</div>
}));

afterEach(cleanupRendererTestEnvironment);

describe("WorkspaceTabs lazy routes", () => {
  it.each([
    ["graph", "graph-route"],
    ["canvas-map", "canvas-map-route"],
    ["notifications", "notifications-route"],
    ["review-pipeline", "review-pipeline-route"],
    ["search", "search-route"],
    ["statistics", "statistics-route"],
    ["todo", "todo-route"],
    ["task-workspace", "task-workspace-route"]
  ] as const)("loads the %s route through its async boundary", async (activeView, testId) => {
    useProjectWorkspace.mockReturnValue({
      autoRun: {},
      fileSync: {},
      graphWorkspace: {},
      notifications: {},
      planning: {},
      review: {},
      search: {},
      shell: {
        activeView,
        t: (key: string) => key
      }
    });

    render(<WorkspaceTabs />);

    expect(screen.getByText("loadingProject")).toBeInTheDocument();
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });
});
