/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TaskWorkspaceUsage } from "../renderer/task-workspace/inspector/TaskWorkspaceUsage";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  taskWorkspaceInspectorFixture,
  taskWorkspaceUsageLabelsFixture as labels
} from "./helpers/taskWorkspaceInspectorFixture";

afterEach(cleanupRendererTestEnvironment);

describe("TaskWorkspaceUsage", () => {
  it("presents the latest context snapshot without promoting it to run or task totals", async () => {
    const fixture = taskWorkspaceInspectorFixture();
    const user = userEvent.setup();
    render(
      <TaskWorkspaceUsage
        labels={labels}
        selectedRun={fixture.selectedRun}
        workspace={fixture.workspace}
      />
    );

    const trigger = screen.getByRole("button", { name: /Context usage: 18,300 \/ 25,800 tokens/ });
    expect(trigger).toHaveAccessibleName(/Latest snapshot only/);
    expect(screen.getByText("gpt-5")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    await user.click(trigger);

    expect(screen.getByText("Current context")).toBeInTheDocument();
    expect(screen.getByText("18,300 / 25,800 tokens")).toBeInTheDocument();
    expect(screen.getByText("71% used")).toBeInTheDocument();
    expect(screen.getByText("Latest snapshot only")).toBeInTheDocument();
    expect(screen.getByText("USD 0.42")).toBeInTheDocument();
    expect(screen.getByText("Reported session cost snapshot; not final run cost")).toBeInTheDocument();
    expect(screen.getByText("Current run")).toBeInTheDocument();
    expect(screen.getByText("Task total")).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("300s")).toBeInTheDocument();
    expect(screen.getAllByText("120s")).toHaveLength(2);
    expect(screen.getByText("1 included, 1 missing")).toBeInTheDocument();
  });

  it("keeps context, run, and task usage unavailable when no snapshot exists", async () => {
    const fixture = taskWorkspaceInspectorFixture({ contextSnapshot: false });
    const user = userEvent.setup();
    render(
      <TaskWorkspaceUsage
        labels={labels}
        selectedRun={fixture.selectedRun}
        workspace={fixture.workspace}
      />
    );

    const trigger = screen.getByRole("button", { name: "Context usage: Unavailable" });
    await user.keyboard("{Tab}{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog")).toHaveFocus();
    expect(screen.getByText("Current context")).toBeInTheDocument();
    expect(screen.getByText("No authoritative current-context snapshot was recorded.")).toBeInTheDocument();
    expect(screen.queryByText("USD 0.42")).not.toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(5);
  });

  it("renders authoritative zero snapshots and durations instead of treating zero as unavailable", async () => {
    const fixture = taskWorkspaceInspectorFixture({ zeroMetrics: true });
    const user = userEvent.setup();
    render(
      <TaskWorkspaceUsage
        labels={labels}
        selectedRun={fixture.selectedRun}
        workspace={fixture.workspace}
      />
    );

    const trigger = screen.getByRole("button", {
      name: /Context usage: 0 \/ 25,800 tokens; 0% used/
    });
    expect(trigger).toHaveTextContent("0%");
    await user.click(trigger);

    expect(screen.getByText("0 / 25,800 tokens")).toBeInTheDocument();
    expect(screen.getByText("USD 0.00")).toBeInTheDocument();
    expect(screen.getByText("0% used")).toBeInTheDocument();
    expect(screen.getAllByText("0s")).toHaveLength(3);
    expect(screen.getByText("Reported session cost snapshot; not final run cost")).toBeInTheDocument();
  });
});
