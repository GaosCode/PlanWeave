/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { ResourceInspector } from "../renderer/inspector/ResourceInspector";

afterEach(cleanup);

const overlapMessagePattern = /multiple tasks are currently using this resource/i;
const desktopTaskButtonPattern = /T-B · Desktop work/;

function sharedResourceGraph(): DesktopGraphViewModel {
  const titleByTaskId: Record<string, string> = {
    "T-A": "Runtime work",
    "T-B": "Desktop work"
  };
  const task = (taskId: string, status: "in_progress" | "ready") => ({
    taskId,
    title: titleByTaskId[taskId] ?? `${taskId} work`,
    status,
    executor: null,
    executorLabel: "manual",
    promptMarkdown: "",
    promptMissing: false,
    promptPreview: "",
    sharedResources: ["packages/runtime"],
    blocks: [
      {
        ref: `${taskId}#B-001`,
        blockId: "B-001",
        type: "implementation" as const,
        title: "Implementation",
        status,
        executor: null,
        promptMissing: false,
        exceptionReason: null,
        dispatchable: status === "ready"
      }
    ],
    blockPreview: [],
    hiddenBlockRefs: [],
    overflowBlockCount: 0,
    exceptions: []
  });
  return {
    projectId: "P-001",
    projectTitle: "Project",
    graphVersion: "pgv",
    packageFingerprint: "pkg",
    executorOptions: [],
    autoRunPreflightExecutorHint: null,
    tasks: [task("T-A", "in_progress"), task("T-B", "ready")],
    edges: [],
    sharedResourceGroups: [
      {
        name: "packages/runtime",
        memberTaskIds: ["T-A", "T-B"],
        memberBlockRefs: ["T-A#B-001", "T-B#B-001"],
        activeBlockRefs: ["T-A#B-001", "T-B#B-001"]
      }
    ],
    diagnostics: [],
    dirtyPromptRefs: []
  };
}

describe("ResourceInspector shared-resource hints", () => {
  it("shows overlap as non-blocking information without scheduling actions", async () => {
    const graph = sharedResourceGraph();
    const group = graph.sharedResourceGroups[0];
    if (!group) {
      throw new Error("Missing shared resource group fixture.");
    }
    const onJumpToTask = vi.fn();
    render(
      <ResourceInspector
        graph={graph}
        resourceGroup={group}
        onClose={vi.fn()}
        onJumpToTask={onJumpToTask}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByText("Shared resource")).toBeInTheDocument();
    expect(screen.getByText(overlapMessagePattern)).toBeInTheDocument();
    expect(screen.queryByTestId("resource-inspector-dispatch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("resource-inspector-mark-blocked")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: desktopTaskButtonPattern }));
    expect(onJumpToTask).toHaveBeenCalledWith("T-B");
  });
});
