/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
      iconName: "activity"
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
    expect(marker).toHaveClass("bg-transparent");
    expect(marker.querySelector("[data-status-icon='empty-circle']")).toBeInTheDocument();
  });
});
