/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerticalResizeHandle } from "../renderer/components/VerticalResizeHandle";

describe("VerticalResizeHandle", () => {
  it.each([
    ["left", "left-0", "after:left-0"],
    ["right", "right-0", "after:right-0"]
  ] as const)("keeps a transparent hit area and one lightweight %s edge", (side, edge, lineEdge) => {
    render(
      <VerticalResizeHandle
        aria-label={`Resize ${side}`}
        role="separator"
        side={side}
      />
    );

    const separator = screen.getByRole("separator", { name: `Resize ${side}` });
    expect(separator).toHaveClass(
      "w-2",
      "bg-transparent",
      "after:w-px",
      "after:bg-border/80",
      "hover:after:bg-foreground/30",
      "active:after:bg-foreground/50",
      edge,
      lineEdge
    );
    expect(separator).not.toHaveClass("hover:bg-state-selected/10", "active:bg-state-selected/20");
  });
});
