/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", () => ({
  ViewportPortal: ({ children }: { children: ReactNode }) => <>{children}</>
}));

import { CanvasPresenceOverlay } from "../renderer/graph/CanvasPresenceOverlay";
import { createTranslator } from "../renderer/i18n";

afterEach(() => vi.restoreAllMocks());

describe("CanvasPresenceOverlay", () => {
  it("renders flow-coordinate cursor labels and deterministic selection outlines", () => {
    const props = {
      edges: [{ id: "edge-1", source: "T-001", target: "T-002" }],
      nodes: [
        { id: "T-001", position: { x: 120, y: 240 }, width: 180, height: 90 },
        { id: "T-002", position: { x: 480, y: 240 }, width: 180, height: 90 }
      ],
      sessions: [
        {
          sessionId: "session-b",
          humanPrincipalId: "human-b",
          displayName: "Bob",
          pointer: { x: 320, y: 200 },
          selectionIds: ["T-001", "edge-1"]
        }
      ]
    } as const;

    const { rerender } = render(<CanvasPresenceOverlay {...props} t={createTranslator("en")} />);
    const cursor = screen
      .getByTestId("canvas-presence-overlay")
      .querySelector('[data-presence-cursor="true"]');
    const stableColor = cursor?.getAttribute("data-presence-color");
    expect(stableColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(cursor).toHaveStyle({ transform: "translate3d(320px, 200px, 0)" });
    expect(screen.getByLabelText("Bob cursor; selected 2 items")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-presence-overlay")).toHaveAttribute(
      "aria-label",
      "Remote collaborators"
    );
    expect(screen.getByLabelText("Bob selected T-001")).toHaveStyle({
      left: "116px",
      top: "236px",
      width: "188px",
      height: "98px"
    });
    expect(screen.getByLabelText("Bob has selected graph edges")).toBeInTheDocument();

    rerender(<CanvasPresenceOverlay {...props} t={createTranslator("zh-CN")} />);
    expect(screen.getByLabelText("Bob 的光标；已选择 2 项")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-presence-overlay")).toHaveAttribute(
      "aria-label",
      "远程协作者"
    );
    expect(
      screen
        .getByTestId("canvas-presence-overlay")
        .querySelector(`[data-presence-color="${stableColor}"]`)
    ).toBeInTheDocument();
  });
});
