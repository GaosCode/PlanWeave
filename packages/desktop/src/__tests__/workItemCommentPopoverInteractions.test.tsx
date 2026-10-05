/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { Panel, ReactFlow } from "@xyflow/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { WorkItemCommentPopover } from "../renderer/team/WorkItemCommentPopover";

vi.mock("../renderer/team/WorkItemCollaborationPanel", () => ({
  WorkItemCollaborationPanel: () => <textarea aria-label="Comment draft" />
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function CommentTrigger({ workItem }: { workItem: WorkItemRef }) {
  const [open, setOpen] = useState(false);
  return (
    <WorkItemCommentPopover
      workItem={workItem}
      commentCount={0}
      open={open}
      onOpenChange={setOpen}
      t={createTranslator("en")}
    />
  );
}

describe("graph work-item comment dismissal", () => {
  it.each<WorkItemRef>([
    { kind: "task", canvasId: "default", taskId: "T-001" },
    { kind: "block", canvasId: "default", blockRef: "T-001#B-001" }
  ])("closes $kind comments on the first blank canvas click", async (workItem) => {
    const onPaneClick = vi.fn();
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow nodes={[]} edges={[]} onPaneClick={onPaneClick}>
          <Panel position="top-right">
            <CommentTrigger workItem={workItem} />
          </Panel>
        </ReactFlow>
      </div>
    );
    const trigger = screen.getByTestId("work-item-comments-trigger");
    await userEvent.click(trigger);
    expect(await screen.findByTestId("work-item-comments-popover")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("textbox", { name: "Comment draft" }));
    expect(screen.getByTestId("work-item-comments-popover")).toBeInTheDocument();

    const pane = container.querySelector(".react-flow__pane");
    if (!pane) throw new Error("ReactFlow pane missing");
    fireEvent.pointerDown(pane, { button: 0, pointerType: "mouse" });
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1 });
    Object.defineProperty(mouseDown, "view", { value: pane.ownerDocument.defaultView });
    fireEvent(pane, mouseDown);
    fireEvent.pointerUp(pane, { button: 0, pointerType: "mouse" });
    const mouseUp = new MouseEvent("mouseup", { bubbles: true, button: 0 });
    Object.defineProperty(mouseUp, "view", { value: pane.ownerDocument.defaultView });
    fireEvent(pane, mouseUp);
    fireEvent.click(pane, { button: 0 });

    await waitFor(() => expect(screen.queryByTestId("work-item-comments-popover")).toBeNull());
    expect(onPaneClick).toHaveBeenCalledTimes(1);
    await userEvent.click(trigger);
    expect(await screen.findByTestId("work-item-comments-popover")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("work-item-comments-popover")).toBeNull());
  });
});
