/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
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
  it("shows the actual model and reasoning when the agent name is hovered", async () => {
    const fixture = taskWorkspaceInspectorFixture();
    const user = userEvent.setup();
    render(
      <TaskWorkspaceUsage
        labels={labels}
        selectedRun={fixture.selectedRun}
        workspace={fixture.workspace}
      />
    );

    const trigger = screen.getByRole("button", { name: "Agent: codex" });
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Model")).toBeInTheDocument();
    expect(within(tooltip).getByText("gpt-5")).toBeInTheDocument();
    expect(within(tooltip).getByText("Reasoning")).toBeInTheDocument();
    expect(within(tooltip).getByText("high")).toBeInTheDocument();
  });

  it("shows only the latest context snapshot in a hover tooltip", async () => {
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
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Context usage")).toBeInTheDocument();
    expect(within(tooltip).getByText("18,300 / 25,800 tokens")).toBeInTheDocument();
    expect(within(tooltip).getByText("71% used")).toBeInTheDocument();
    expect(screen.queryByText("Current run")).not.toBeInTheDocument();
    expect(screen.queryByText("Task total")).not.toBeInTheDocument();
    expect(screen.queryByText("USD 0.42")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows unavailable context on keyboard focus without opening a dialog", async () => {
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
    await user.tab();
    expect(screen.getByRole("button", { name: "Agent: codex" })).toHaveFocus();
    await user.tab();
    expect(trigger).toHaveFocus();
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("0 / 25,800 tokens")).toBeInTheDocument();
    expect(within(tooltip).getByText("0% used")).toBeInTheDocument();
    expect(screen.queryByText("USD 0.00")).not.toBeInTheDocument();
  });
});
