/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedResourceBadges } from "../renderer/graph/sharedResourceBadges";
import {
  SHARED_RESOURCE_OVERFLOW_LIMIT,
  sharedResourceColor
} from "../renderer/graph/sharedResourceColors";

afterEach(cleanup);

const labels = {
  sharedResource: "Shared resource",
  sharedResourceActive: "Active shared resource",
  moreResources: (count: number) => `+${count}`
};

describe("shared-resource colors and badges", () => {
  it("returns stable colors for resource names", () => {
    expect(sharedResourceColor("db")).toEqual(sharedResourceColor("db"));
    expect(sharedResourceColor("api").dot).not.toEqual(sharedResourceColor("db").dot);
  });

  it("renders informational inactive and active resource states", () => {
    render(
      <SharedResourceBadges
        resources={["db", "api"]}
        activeResources={new Set(["db"])}
        highlightedResource={null}
        transitionEpochByResource={{}}
        labels={labels}
        onResourceHover={vi.fn()}
        onResourcePin={vi.fn()}
      />
    );

    const chips = screen.getAllByTestId("task-node-resource-chip");
    expect(chips[0]).toHaveAttribute("data-resource-active", "true");
    expect(chips[1]).toHaveAttribute("data-resource-active", "false");
  });

  it("preserves hover, pin, transition pulse, and overflow interactions", () => {
    const resources = ["a", "b", "c", "d"];
    const onResourceHover = vi.fn();
    const onResourcePin = vi.fn();
    render(
      <SharedResourceBadges
        resources={resources}
        activeResources={new Set()}
        highlightedResource="a"
        transitionEpochByResource={{ a: 1 }}
        labels={labels}
        onResourceHover={onResourceHover}
        onResourcePin={onResourcePin}
      />
    );

    const chips = screen.getAllByTestId("task-node-resource-chip");
    expect(chips).toHaveLength(SHARED_RESOURCE_OVERFLOW_LIMIT);
    expect(screen.getByTestId("task-node-resource-transition").className).toContain(
      "shared-resource-transition-pulse"
    );
    fireEvent.mouseEnter(chips[0]!);
    fireEvent.mouseLeave(chips[0]!);
    fireEvent.click(chips[0]!);
    expect(onResourceHover).toHaveBeenNthCalledWith(1, "a");
    expect(onResourceHover).toHaveBeenNthCalledWith(2, null);
    expect(onResourcePin).toHaveBeenCalledWith("a");

    onResourcePin.mockClear();
    fireEvent.click(screen.getByTestId("task-node-resource-overflow"));
    const list = screen.getByTestId("task-node-resource-list");
    expect(list).toHaveAttribute("data-side", "bottom");
    expect(within(list).getAllByRole("button")).toHaveLength(4);
    expect(onResourcePin).not.toHaveBeenCalled();
    fireEvent.click(within(list).getByRole("button", { name: "d" }));
    expect(onResourcePin).toHaveBeenCalledExactlyOnceWith("d");
    expect(screen.queryByTestId("task-node-resource-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("task-node-resource-overflow")).toHaveTextContent("+1");
  });

  it("opens beside its trigger with keyboard access without selecting the task or a resource", async () => {
    const onTaskClick = vi.fn();
    const onResourcePin = vi.fn();
    render(
      <div role="treeitem" tabIndex={0} onClick={onTaskClick} onKeyDown={() => undefined}>
        <SharedResourceBadges
          resources={["a", "b", "c", "d"]}
          activeResources={new Set(["d"])}
          highlightedResource="b"
          transitionEpochByResource={{}}
          labels={labels}
          onResourceHover={vi.fn()}
          onResourcePin={onResourcePin}
        />
      </div>
    );
    const trigger = screen.getByTestId("task-node-resource-overflow");
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByTestId("task-node-resource-list");
    expect(within(list).getByRole("button", { name: "d" })).toBeVisible();
    expect(onResourcePin).not.toHaveBeenCalled();
    expect(onTaskClick).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("task-node-resource-list")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("remounts only the pulse layer when the transition epoch changes", () => {
    const props = {
      resources: ["db"],
      activeResources: new Set<string>(),
      highlightedResource: "db",
      labels,
      onResourceHover: vi.fn(),
      onResourcePin: vi.fn()
    };
    const { rerender } = render(
      <SharedResourceBadges {...props} transitionEpochByResource={{ db: 1 }} />
    );
    const chip = screen.getByTestId("task-node-resource-chip");
    const firstPulseLayer = screen.getByTestId("task-node-resource-transition");
    expect(firstPulseLayer).toHaveAttribute("data-transition-epoch", "1");

    rerender(<SharedResourceBadges {...props} transitionEpochByResource={{ db: 2 }} />);

    const secondPulseLayer = screen.getByTestId("task-node-resource-transition");
    expect(screen.getByTestId("task-node-resource-chip")).toBe(chip);
    expect(secondPulseLayer).not.toBe(firstPulseLayer);
    expect(secondPulseLayer).toHaveAttribute("data-transition-epoch", "2");
  });
});
