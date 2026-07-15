/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
        onOverflowOpen={vi.fn()}
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
    const onOverflowOpen = vi.fn();
    render(
      <SharedResourceBadges
        resources={resources}
        activeResources={new Set()}
        highlightedResource="a"
        transitionEpochByResource={{ a: 1 }}
        labels={labels}
        onResourceHover={onResourceHover}
        onResourcePin={onResourcePin}
        onOverflowOpen={onOverflowOpen}
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

    fireEvent.click(screen.getByTestId("task-node-resource-overflow"));
    expect(onOverflowOpen).toHaveBeenCalledOnce();
    expect(screen.getByTestId("task-node-resource-overflow")).toHaveTextContent("+1");
  });

  it("remounts only the pulse layer when the transition epoch changes", () => {
    const props = {
      resources: ["db"],
      activeResources: new Set<string>(),
      highlightedResource: "db",
      labels,
      onResourceHover: vi.fn(),
      onResourcePin: vi.fn(),
      onOverflowOpen: vi.fn()
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
