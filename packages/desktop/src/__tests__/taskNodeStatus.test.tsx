/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";
import { taskNodeSelectedClassName } from "../renderer/graph/TaskNodeCard";
import { TaskNodeStatusMarker, taskNodeStatusVisual } from "../renderer/graph/taskNodeStatus";

afterEach(() => {
  cleanup();
});

describe("task node status visuals", () => {
  it("maps task node states to card tones and clean status icons", () => {
    expect(taskNodeStatusVisual("ready", false)).toMatchObject({
      tone: "neutral",
      iconName: "empty-circle"
    });
    expect(taskNodeStatusVisual("in_progress", false)).toMatchObject({
      tone: "running",
      iconName: "loader"
    });
    expect(taskNodeStatusVisual("implemented", false)).toMatchObject({
      tone: "complete",
      iconName: "check"
    });
    expect(taskNodeStatusVisual("ready", true)).toMatchObject({
      tone: "problem",
      iconName: "alert"
    });

    render(<TaskNodeStatusMarker hasException={false} label="ready" status="ready" />);

    const marker = screen.getByTestId("task-node-status-marker");
    expect(marker).toHaveAttribute("data-status-tone", "neutral");
    expect(marker).toHaveClass("bg-surface-muted");
    expect(marker.querySelector("[data-status-icon='empty-circle']")).toBeInTheDocument();
  });

  it("uses a spinning loader for in-progress task nodes", () => {
    render(<TaskNodeStatusMarker hasException={false} label="in_progress" status="in_progress" />);

    const icon = screen
      .getByTestId("task-node-status-marker")
      .querySelector("[data-status-icon='loader']");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveClass("animate-spin");
  });

  it("keeps problem card border and ring classes when a task node is selected", () => {
    const visual = taskNodeStatusVisual("ready", true);
    const className = cn("border", visual.cardClassName, taskNodeSelectedClassName);

    expect(className).toContain("border-state-failed/60");
    expect(className).toContain("ring-state-failed/15");
    expect(className).toContain("outline-state-selected");
  });

  it("maps ready-but-waiting tasks to the waiting tone with hourglass icon", () => {
    expect(taskNodeStatusVisual("ready", false, { waiting: true })).toMatchObject({
      tone: "waiting",
      iconName: "hourglass"
    });
    // problem and running outrank waiting
    expect(taskNodeStatusVisual("ready", true, { waiting: true }).tone).toBe("problem");
    expect(taskNodeStatusVisual("in_progress", false, { waiting: true }).tone).toBe("running");

    render(
      <TaskNodeStatusMarker
        hasException={false}
        label="Waiting for resource"
        status="ready"
        waiting
      />
    );
    expect(screen.getByTestId("task-node-status-marker")).toHaveAttribute(
      "data-status-tone",
      "waiting"
    );
  });
});
