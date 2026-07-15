/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DesktopCanvasGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasNodeCard } from "../renderer/graph/CanvasNodeCard";
import { createTranslator } from "../renderer/i18n";
import { CanvasTreeItem } from "../renderer/sidebar/CanvasTreeItem";
import { CanvasMapInspector } from "../renderer/views/CanvasMapInspector";

vi.mock("@xyflow/react", () => ({
  // biome-ignore lint/style/useNamingConvention: Matches the external module export.
  Handle: () => <div data-testid="react-flow-handle" />,
  // biome-ignore lint/style/useNamingConvention: Matches the external module export.
  Position: {
    // biome-ignore lint/style/useNamingConvention: Matches the external module enum keys.
    Left: "left",
    // biome-ignore lint/style/useNamingConvention: Matches the external module enum keys.
    Right: "right"
  }
}));

const t = createTranslator("en");
const warningCanvasButtonName = /Warning canvas\s*2/;
const errorCanvasButtonName = /Warning canvas Error:/;
const warningDiagnostic = {
  code: "prompt_duplicate_many",
  message: "Prompt text is duplicated across several blocks",
  path: "nodes.0.blocks",
  severity: "warning" as const
};
const warningCanvas = {
  canvasId: "warning-canvas",
  name: "Warning canvas",
  packageDir: "canvases/warning-canvas/package",
  executionPolicy: { parallelEnabled: true, maxConcurrent: 3 },
  taskCount: 2,
  missingPromptCount: 0,
  diagnostics: [warningDiagnostic],
  createdAt: "2026-05-23T00:00:00.000Z",
  updatedAt: "2026-05-23T00:00:00.000Z"
};
const warningProject: DesktopProjectSummary = {
  projectId: "P-WARNING",
  name: "Warning project",
  kind: "managed",
  rootPath: "/tmp/warning-project",
  sourceRoot: null,
  workspaceRoot: "/tmp/warning-project",
  activeCanvasId: warningCanvas.canvasId,
  taskCanvases: [warningCanvas]
};
const warningCanvasGraph: DesktopCanvasGraphViewModel = {
  projectId: warningProject.projectId,
  projectTitle: warningProject.name,
  canvases: [
    {
      canvasId: warningCanvas.canvasId,
      title: warningCanvas.name,
      status: "ready",
      packageDir: warningCanvas.packageDir,
      executionPolicy: warningCanvas.executionPolicy,
      diagnostics: warningCanvas.diagnostics
    }
  ],
  edges: [],
  crossTaskEdges: [],
  diagnostics: [],
  health: {
    severity: "warning",
    canvases: [
      {
        canvasId: warningCanvas.canvasId,
        severity: "warning",
        blockerCount: 0,
        diagnosticCount: 1
      }
    ],
    edges: [],
    blockedBlocks: [],
    diagnostics: []
  }
};

afterEach(cleanup);

describe("canvas diagnostic severity in the sidebar", () => {
  it("keeps warning-only canvases unobstructed in the sidebar", () => {
    render(
      <CanvasTreeItem
        canvas={warningCanvas}
        graph={null}
        handleCopyCanvasToNewProject={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleDeleteTaskNode={vi.fn().mockResolvedValue(undefined)}
        handleDuplicateTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleProjectNewGraph={vi.fn().mockResolvedValue(undefined)}
        handleRenameTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleRevealTaskCanvas={vi.fn().mockResolvedValue(undefined)}
        handleRevealTaskNode={vi.fn()}
        handleTaskPanelSelect={vi.fn()}
        isExpandedCanvas={false}
        isGraphCanvas={true}
        onCanvasSelect={vi.fn()}
        onCanvasToggle={vi.fn()}
        project={warningProject}
        selectedTaskPanelId={null}
        t={t}
      />
    );

    expect(screen.getByRole("button", { name: warningCanvasButtonName })).toBeVisible();
    expect(screen.queryByRole("button", { name: errorCanvasButtonName })).not.toBeInTheDocument();
    expect(screen.queryByText("Warning")).not.toBeInTheDocument();
  });
});

describe("canvas diagnostic severity in the canvas map node", () => {
  it("uses warning styling for a warning-only canvas map node", () => {
    render(
      <CanvasNodeCard
        {...({
          data: {
            canvas: warningCanvasGraph.canvases[0],
            health: warningCanvasGraph.health.canvases[0],
            labels: {
              copyAgentPrompt: "Copy agent prompt",
              dependency: "Dependency",
              error: "Error",
              open: "Open",
              openInFileManager: "Open in Finder",
              rename: "Rename",
              warning: "Warning"
            },
            onAgentPromptCopy: vi.fn(),
            onOpen: vi.fn(),
            onRename: vi.fn(),
            onRevealInFinder: vi.fn(),
            onSelect: vi.fn(),
            selected: false
          }
        } as Parameters<typeof CanvasNodeCard>[0])}
      />
    );

    const card = document.querySelector('[data-slot="context-menu-trigger"]');

    expect(screen.getByText("Warning")).toBeVisible();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
    expect(card).toHaveClass("border-state-warning/75");
    expect(card).toHaveClass("bg-state-warning-surface");
    expect(card).not.toHaveClass("border-state-failed/70");
  });
});

describe("canvas execution status in the canvas map node", () => {
  it("uses the shared running status visual even when the canvas has warnings", () => {
    const runningCanvas = {
      ...warningCanvasGraph.canvases[0],
      status: "in_progress" as const
    };

    render(
      <CanvasNodeCard
        {...({
          data: {
            canvas: runningCanvas,
            health: warningCanvasGraph.health.canvases[0],
            labels: {
              copyAgentPrompt: "Copy agent prompt",
              dependency: "Dependency",
              error: "Error",
              open: "Open",
              openInFileManager: "Open in Finder",
              rename: "Rename",
              warning: "Warning"
            },
            onAgentPromptCopy: vi.fn(),
            onOpen: vi.fn(),
            onRename: vi.fn(),
            onRevealInFinder: vi.fn(),
            onSelect: vi.fn(),
            selected: false
          }
        } as Parameters<typeof CanvasNodeCard>[0])}
      />
    );

    const marker = screen.getByTestId("task-node-status-marker");
    const card = document.querySelector('[data-slot="context-menu-trigger"]');

    expect(marker).toHaveAttribute("data-status-tone", "running");
    expect(marker).toHaveTextContent("in_progress");
    expect(card).toHaveClass("border-state-running/55");
    expect(card).toHaveClass("bg-state-running-surface");
    expect(card).not.toHaveClass("bg-state-warning-surface");
  });

  it.each([
    "planned",
    "ready"
  ] as const)("keeps %s canvases neutral while they wait for dependencies", (status) => {
    render(
      <CanvasNodeCard
        {...({
          data: {
            canvas: { ...warningCanvasGraph.canvases[0], diagnostics: [], status },
            health: {
              ...warningCanvasGraph.health.canvases[0],
              blockerCount: 1,
              diagnosticCount: 0
            },
            labels: {
              copyAgentPrompt: "Copy agent prompt",
              dependency: "Dependency",
              error: "Error",
              open: "Open",
              openInFileManager: "Open in Finder",
              rename: "Rename",
              warning: "Warning"
            },
            onAgentPromptCopy: vi.fn(),
            onOpen: vi.fn(),
            onRename: vi.fn(),
            onRevealInFinder: vi.fn(),
            onSelect: vi.fn(),
            selected: false
          }
        } as Parameters<typeof CanvasNodeCard>[0])}
      />
    );

    const card = document.querySelector('[data-slot="context-menu-trigger"]');
    expect(card).toHaveClass("bg-surface-raised");
    expect(card).not.toHaveClass("bg-state-warning-surface");
    expect(screen.getByText("Dependency")).toBeVisible();
  });
});

describe("canvas diagnostic severity in the canvas inspector", () => {
  it("uses warning styling for warning diagnostics in the canvas inspector", () => {
    render(
      <CanvasMapInspector
        graph={warningCanvasGraph}
        onClose={vi.fn()}
        onBlockOpen={vi.fn()}
        onCanvasOpen={vi.fn()}
        onExecutionPolicySave={vi.fn().mockResolvedValue(undefined)}
        onTaskOpen={vi.fn()}
        selectedCanvas={warningCanvasGraph.canvases[0] ?? null}
        selectedCanvasId={warningCanvas.canvasId}
        selectedEdge={null}
        t={t}
      />
    );

    const diagnostic = screen.getByText("prompt_duplicate_many").parentElement;

    expect(screen.getByText("Warning")).toBeVisible();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
    expect(screen.queryByText("Dependency health")).not.toBeInTheDocument();
    expect(diagnostic).toHaveClass("border-state-warning/60");
    expect(diagnostic).toHaveClass("bg-state-warning-surface");
    expect(diagnostic).not.toHaveClass("border-destructive/30");
  });
});
