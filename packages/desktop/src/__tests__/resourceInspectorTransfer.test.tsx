/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { ResourceInspector } from "../renderer/inspector/ResourceInspector";

const markBlockedBlock = vi.fn().mockResolvedValue(undefined);
const dispatchBlock = vi.fn().mockResolvedValue({
  kind: "block",
  ref: "T-B#B-001",
  taskId: "T-B",
  blockId: "B-001",
  blockType: "implementation",
  effectiveExecutor: "manual",
  reason: "dispatched"
});
const unblockBlock = vi.fn().mockResolvedValue(undefined);

vi.mock("../renderer/bridge", () => ({
  bridge: {
    markBlockedBlock: (...args: unknown[]) => markBlockedBlock(...args),
    dispatchBlock: (...args: unknown[]) => dispatchBlock(...args),
    unblockBlock: (...args: unknown[]) => unblockBlock(...args)
  },
  desktopCanvasReference: (project: { rootPath: string }, canvasId?: string | null) => ({
    projectRoot: project.rootPath,
    canvasId
  })
}));

afterEach(() => {
  cleanup();
  markBlockedBlock.mockClear();
  dispatchBlock.mockClear();
  unblockBlock.mockClear();
});

function holderGraph(): DesktopGraphViewModel {
  return {
    projectId: "P-001",
    projectTitle: "Project",
    graphVersion: "pgv",
    packageFingerprint: "pkg",
    executorOptions: [],
    autoRunPreflightExecutorHint: null,
    tasks: [
      {
        taskId: "T-A",
        title: "Holder",
        status: "in_progress",
        executor: null,
        executorLabel: "manual",
        promptMarkdown: "",
        promptMissing: false,
        promptPreview: "",
        locks: ["db"],
        blocks: [
          {
            ref: "T-A#B-001",
            blockId: "B-001",
            type: "implementation",
            title: "Hold db",
            status: "in_progress",
            executor: null,
            promptMissing: false,
            exceptionReason: null,
            dispatchable: false,
            waitingOn: null
          }
        ],
        blockPreview: [],
        hiddenBlockRefs: [],
        overflowBlockCount: 0,
        exceptions: []
      },
      {
        taskId: "T-B",
        title: "Waiter",
        status: "ready",
        executor: null,
        executorLabel: "manual",
        promptMarkdown: "",
        promptMissing: false,
        promptPreview: "",
        locks: ["db"],
        blocks: [
          {
            ref: "T-B#B-001",
            blockId: "B-001",
            type: "implementation",
            title: "Wait db",
            status: "ready",
            executor: null,
            promptMissing: false,
            exceptionReason: null,
            dispatchable: false,
            waitingOn: { lock: "db", holderRef: "T-A#B-001" }
          }
        ],
        blockPreview: [],
        hiddenBlockRefs: [],
        overflowBlockCount: 0,
        exceptions: []
      }
    ],
    edges: [],
    lockGroups: [{ name: "db", memberTaskIds: ["T-A", "T-B"], holderRef: "T-A#B-001" }],
    diagnostics: [],
    dirtyPromptRefs: []
  };
}

function releasedGraph(): DesktopGraphViewModel {
  const graph = holderGraph();
  return {
    ...graph,
    lockGroups: [{ name: "db", memberTaskIds: ["T-A", "T-B"], holderRef: null }],
    tasks: graph.tasks.map((task) => {
      if (task.taskId === "T-A") {
        return {
          ...task,
          status: "blocked",
          blocks: task.blocks.map((block) => ({
            ...block,
            status: "blocked",
            exceptionReason: "paused for transfer"
          })),
          exceptions: [
            { ref: "T-A#B-001", source: "blocked" as const, reason: "paused for transfer" }
          ]
        };
      }
      return {
        ...task,
        blocks: task.blocks.map((block) => ({
          ...block,
          dispatchable: true,
          waitingOn: null
        }))
      };
    })
  };
}

describe("ResourceInspector pause-and-transfer", () => {
  it("marks holder blocked then enables dispatch on the waiter", async () => {
    const user = userEvent.setup();
    let graph = holderGraph();
    const onRefresh = vi.fn(async () => {
      graph = releasedGraph();
    });
    const canvasRef = { projectRoot: "/tmp/project", canvasId: "default" };

    const { rerender } = render(
      <ResourceInspector
        canvasRef={canvasRef}
        graph={graph}
        lockGroup={graph.lockGroups[0]!}
        onClose={vi.fn()}
        onJumpToTask={vi.fn()}
        onRefresh={onRefresh}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("resource-inspector-dispatch")).toBeDisabled();

    await user.type(screen.getByTestId("resource-inspector-reason"), "paused for transfer");
    await user.click(screen.getByTestId("resource-inspector-mark-blocked"));

    await waitFor(() => {
      expect(markBlockedBlock).toHaveBeenCalledWith(
        canvasRef,
        "T-A#B-001",
        "paused for transfer"
      );
    });
    expect(onRefresh).toHaveBeenCalled();

    graph = releasedGraph();
    rerender(
      <ResourceInspector
        canvasRef={canvasRef}
        graph={graph}
        lockGroup={graph.lockGroups[0]!}
        onClose={vi.fn()}
        onJumpToTask={vi.fn()}
        onRefresh={onRefresh}
        t={createTranslator("en")}
      />
    );

    const dispatchButton = screen.getByTestId("resource-inspector-dispatch");
    expect(dispatchButton).not.toBeDisabled();
    await user.click(dispatchButton);
    await waitFor(() => {
      expect(dispatchBlock).toHaveBeenCalledWith(canvasRef, "T-B#B-001");
    });
  });
});
