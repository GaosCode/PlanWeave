import { useCallback, useLayoutEffect, useRef } from "react";
import type * as React from "react";
import type { Connection, Edge, Node, ReactFlowInstance } from "@xyflow/react";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopLayout,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import { submitSharedPackageIntent } from "../collaboration/packageWriteAdapter";
import {
  dependencyConnectionToManifestEndpoints,
  dependencyDisplayEdgeToManifestEndpoints
} from "../graph/dependencyEdges";
import type { createTranslator } from "../i18n";
import { visibleBlockSet } from "../settings";
import type {
  AppFlowNode,
  DesktopUiSettings,
  PaletteDropComponent,
  PaletteDropPosition
} from "../types";
import { defaultBlockTitleForUi } from "../viewHelpers";
import type { WorkspaceCanvasCommandsResult } from "./useWorkspaceCanvasCommands";

import type { CanvasLocator } from "../../shared/canvasLocator";
import type {
  DesktopSelectionReceipt,
  ApplyDesktopProjectSnapshotOptions
} from "./useDesktopProjectSnapshot";

type UseGraphPaletteActionsArgs = {
  captureProjectSelection: () => DesktopSelectionReceipt;
  canvasLocator?: CanvasLocator | null;
  flowInstance: ReactFlowInstance<AppFlowNode, Edge> | null;
  getLayoutNodes?: (dragStopNode?: Node) => AppFlowNode[];
  graph: DesktopGraphViewModel | null;
  layout: DesktopLayout | null;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  nodes: AppFlowNode[];
  refreshProjectDerivedState: (options?: ApplyDesktopProjectSnapshotOptions) => Promise<void>;
  selectedCanvasId: string | null;
  selectedBlock: DesktopBlockDetail | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setError: (message: string | null) => void;
  setLayout: (layout: DesktopLayout | null) => void;
  selectTaskPanel: (taskId: string | null) => void;
  settings: DesktopUiSettings;
  t: ReturnType<typeof createTranslator>;
  /** When enabled, durable graph writes go through server-authoritative canvas commands. */
  workspaceCanvas?: WorkspaceCanvasCommandsResult | null;
};

function nextClientTaskId(graph: DesktopGraphViewModel | null): string {
  const existing = new Set(graph?.tasks.map((task) => task.taskId) ?? []);
  let index = existing.size + 1;
  while (existing.has(`T-${String(index).padStart(3, "0")}`)) index += 1;
  return `T-${String(index).padStart(3, "0")}`;
}

function nextClientBlockId(
  graph: DesktopGraphViewModel | null,
  taskId: string,
  type: "implementation" | "review"
): string {
  const task = graph?.tasks.find((item) => item.taskId === taskId);
  const existing = new Set(task?.blocks.map((block) => block.blockId) ?? []);
  const prefix = type === "review" ? "R" : "B";
  let index = 1;
  while (existing.has(`${prefix}-${String(index).padStart(3, "0")}`)) index += 1;
  return `${prefix}-${String(index).padStart(3, "0")}`;
}

function currentLayoutSnapshot(
  graph: DesktopGraphViewModel | null,
  layout: DesktopLayout | null,
  nodes: AppFlowNode[]
): DesktopLayout | undefined {
  if (!graph || nodes.length === 0) {
    return undefined;
  }
  return {
    version: "desktop-layout/v1",
    projectId: layout?.projectId ?? graph.projectId,
    nodes: nodes.map((node) => ({
      nodeId: node.id,
      x: node.position.x,
      y: node.position.y
    })),
    updatedAt: layout?.updatedAt ?? new Date(0).toISOString()
  };
}

export function useGraphPaletteActions({
  captureProjectSelection,
  canvasLocator = null,
  flowInstance,
  getLayoutNodes,
  graph,
  layout,
  loadProject,
  nodes,
  refreshProjectDerivedState,
  selectedCanvasId,
  selectedBlock,
  selectedProject,
  selectedTaskPanelId,
  setError,
  setLayout,
  selectTaskPanel,
  settings,
  t,
  workspaceCanvas = null
}: UseGraphPaletteActionsArgs) {
  const scopeGeneration = useRef(0);
  const scopeKey = JSON.stringify([selectedProject?.rootPath, selectedCanvasId, canvasLocator]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every navigation identity change invalidates in-flight graph operations.
  useLayoutEffect(() => {
    scopeGeneration.current += 1;
    return () => {
      scopeGeneration.current += 1;
    };
  }, [scopeKey]);

  const getPersistableLayoutNodes = useCallback(
    (dragStopNode?: Node) => getLayoutNodes?.(dragStopNode) ?? nodes,
    [getLayoutNodes, nodes]
  );

  const handleNodeDragStop = useCallback(
    async (_event: React.MouseEvent, node: Node) => {
      const layoutNodes = getPersistableLayoutNodes(node).map((item) => ({
        nodeId: item.id,
        x: item.id === node.id && !getLayoutNodes ? node.position.x : item.position.x,
        y: item.id === node.id && !getLayoutNodes ? node.position.y : item.position.y
      }));
      if (workspaceCanvas?.enabled) {
        const updatedAt = new Date().toISOString();
        const ok = await submitSharedPackageIntent(
          workspaceCanvas,
          { kind: "update_layout", nodes: layoutNodes, updatedAt },
          setError
        );
        if (ok && graph) {
          setLayout({
            version: "desktop-layout/v1",
            projectId: graph.projectId,
            nodes: layoutNodes,
            updatedAt
          });
        }
        return;
      }
      if (!bridge || !selectedProject) return;
      const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
      const baseLayout = layout ?? (await bridge.getDesktopLayout(canvas));
      const nextLayout: DesktopLayout = {
        ...baseLayout,
        nodes: layoutNodes
      };
      const saved = await bridge.saveDesktopLayout(canvas, nextLayout);
      setLayout(saved);
    },
    [
      getLayoutNodes,
      getPersistableLayoutNodes,
      graph,
      layout,
      selectedCanvasId,
      selectedProject,
      setError,
      setLayout,
      workspaceCanvas
    ]
  );

  const resetLayout = useCallback(async () => {
    if (!selectedProject) {
      return;
    }
    if (workspaceCanvas?.enabled) {
      // Workspace commands have no reset_layout intent; write default grid positions via update_layout.
      const layoutNodes =
        graph && graph.tasks.length > 0
          ? graph.tasks.map((task, index) => ({
              nodeId: task.taskId,
              x: 80 + (index % 4) * 320,
              y: 80 + Math.floor(index / 4) * 180
            }))
          : nodes.length > 0
            ? nodes.map((node, index) => ({
                nodeId: node.id,
                x: 80 + (index % 4) * 320,
                y: 80 + Math.floor(index / 4) * 180
              }))
            : null;
      if (!layoutNodes || layoutNodes.length === 0) {
        setLayout({
          version: "desktop-layout/v1",
          projectId: layout?.projectId ?? graph?.projectId ?? selectedProject.projectId,
          nodes: [],
          updatedAt: new Date().toISOString()
        });
        return;
      }
      const updatedAt = new Date().toISOString();
      const ok = await submitSharedPackageIntent(
        workspaceCanvas,
        { kind: "update_layout", nodes: layoutNodes, updatedAt },
        setError
      );
      if (ok) {
        setLayout({
          version: "desktop-layout/v1",
          projectId: layout?.projectId ?? graph?.projectId ?? selectedProject.projectId,
          nodes: layoutNodes,
          updatedAt
        });
      }
      return;
    }
    if (!bridge) {
      return;
    }
    setLayout(
      await bridge.resetDesktopLayout(desktopCanvasReference(selectedProject, selectedCanvasId))
    );
  }, [
    graph,
    layout?.projectId,
    nodes,
    selectedCanvasId,
    selectedProject,
    setError,
    setLayout,
    workspaceCanvas
  ]);

  const handleConnect = useCallback(
    async (connection: Connection) => {
      const manifestEdge = dependencyConnectionToManifestEndpoints(connection);
      if (!selectedProject || !manifestEdge) {
        return;
      }
      try {
        if (workspaceCanvas?.enabled) {
          const ok = await submitSharedPackageIntent(
            workspaceCanvas,
            {
              kind: "add_task_dependency",
              fromTaskId: manifestEdge.from,
              toTaskId: manifestEdge.to
            },
            setError
          );
          if (ok) await refreshProjectDerivedState();
          return;
        }
        if (!bridge) return;
        const result = await bridge.addDependencyEdge(
          desktopCanvasReference(selectedProject, selectedCanvasId),
          manifestEdge.from,
          manifestEdge.to,
          graph?.graphVersion,
          currentLayoutSnapshot(graph, layout, getPersistableLayoutNodes())
        );
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await refreshProjectDerivedState();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      getPersistableLayoutNodes,
      graph,
      layout,
      refreshProjectDerivedState,
      selectedCanvasId,
      selectedProject,
      setError,
      workspaceCanvas
    ]
  );

  const handleEdgesDelete = useCallback(
    async (deletedEdges: Edge[]) => {
      if (!selectedProject) {
        return;
      }
      const pendingEdges = [
        ...new Map(
          deletedEdges.flatMap((edge) => {
            const endpoints = dependencyDisplayEdgeToManifestEndpoints(edge);
            return endpoints
              ? [[JSON.stringify([endpoints.from, endpoints.to]), endpoints] as const]
              : [];
          })
        ).values()
      ].sort(
        (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
      );
      if (pendingEdges.length === 0 || (!workspaceCanvas?.enabled && !bridge)) return;
      const generation = scopeGeneration.current;
      const selection = captureProjectSelection();
      const isCurrent = () => scopeGeneration.current === generation && selection.isCurrent();
      const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
      const layoutSnapshot = currentLayoutSnapshot(graph, layout, getPersistableLayoutNodes());
      let baseVersion = graph?.graphVersion;
      let completed = 0;
      let retired = false;
      const errors: string[] = [];
      try {
        for (const edge of pendingEdges) {
          if (!isCurrent()) break;
          if (workspaceCanvas?.enabled) {
            const result = await workspaceCanvas.submit({
              intent: {
                kind: "remove_task_dependency",
                fromTaskId: edge.from,
                toTaskId: edge.to
              }
            });
            if (result.status === "retired") {
              retired = true;
              break;
            }
            if (!result.ok) {
              if (result.error) errors.push(result.error);
              else errors.push(t("canvasCommandNotConnected"));
              break;
            }
          } else if (bridge) {
            const result = await bridge.removeDependencyEdge(
              canvas,
              edge.from,
              edge.to,
              baseVersion,
              layoutSnapshot
            );
            if (result.committed) {
              completed += 1;
              baseVersion = result.committed.graphVersion;
            }
            if (!result.ok) {
              errors.push(...result.diagnostics.map((diagnostic) => diagnostic.message));
              break;
            }
            if (!result.committed) completed += 1;
            if (!result.graphVersion)
              throw new Error("Dependency deletion result is missing graphVersion.");
            baseVersion = result.graphVersion;
            continue;
          }
          completed += 1;
        }
      } catch (caught) {
        errors.push(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!retired) {
          try {
            await refreshProjectDerivedState({ throwOnErrors: true, isOwnerCurrent: isCurrent });
          } catch (caught) {
            errors.push(
              t("dependencyDeleteRefreshFailed").replace(
                "{reason}",
                caught instanceof Error ? caught.message : String(caught)
              )
            );
          }
        }
        if (!retired && isCurrent() && errors.length > 0) {
          setError(
            [
              t("dependencyDeletePartial")
                .replace("{completed}", String(completed))
                .replace("{remaining}", String(pendingEdges.length - completed)),
              ...errors
            ].join("\n")
          );
        }
      }
    },
    [
      captureProjectSelection,
      getPersistableLayoutNodes,
      graph,
      layout,
      refreshProjectDerivedState,
      selectedCanvasId,
      selectedProject,
      setError,
      workspaceCanvas,
      t
    ]
  );

  const handleReconnectEdge = useCallback(
    async (oldEdge: Edge, connection: Connection) => {
      const oldManifestEdge = dependencyDisplayEdgeToManifestEndpoints(oldEdge);
      const newManifestEdge = dependencyConnectionToManifestEndpoints(connection);
      if (!selectedProject || !oldManifestEdge || !newManifestEdge) {
        return;
      }
      try {
        if (workspaceCanvas?.enabled) {
          const ok = await submitSharedPackageIntent(
            workspaceCanvas,
            {
              kind: "reconnect_task_dependency",
              fromTaskId: oldManifestEdge.from,
              oldToTaskId: oldManifestEdge.to,
              newFromTaskId:
                newManifestEdge.from !== oldManifestEdge.from ? newManifestEdge.from : undefined,
              newToTaskId: newManifestEdge.to
            },
            setError
          );
          if (ok) await refreshProjectDerivedState();
          return;
        }
        if (!bridge) return;
        const result = await bridge.reconnectDependencyEdge(
          desktopCanvasReference(selectedProject, selectedCanvasId),
          oldManifestEdge.from,
          oldManifestEdge.to,
          newManifestEdge.from,
          newManifestEdge.to,
          graph?.graphVersion,
          currentLayoutSnapshot(graph, layout, getPersistableLayoutNodes())
        );
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await refreshProjectDerivedState();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      getPersistableLayoutNodes,
      graph,
      layout,
      refreshProjectDerivedState,
      selectedCanvasId,
      selectedProject,
      setError,
      workspaceCanvas
    ]
  );

  const addPaletteComponent = useCallback(
    async (type: PaletteDropComponent, dropPosition?: PaletteDropPosition) => {
      if (!selectedProject) {
        return;
      }
      try {
        if (workspaceCanvas?.enabled) {
          if (type === "task") {
            const taskId = nextClientTaskId(graph);
            const ok = await submitSharedPackageIntent(
              workspaceCanvas,
              {
                kind: "add_task",
                taskId,
                title: t("defaultTaskTitle"),
                promptMarkdown: t("defaultTaskPrompt"),
                acceptance: [t("defaultTaskAcceptance")],
                executor: settings.defaultExecutor.trim() || undefined,
                ...(dropPosition
                  ? {
                      layout: { nodeId: taskId, x: dropPosition.x, y: dropPosition.y },
                      layoutUpdatedAt: new Date().toISOString()
                    }
                  : {})
              },
              setError
            );
            if (ok) {
              selectTaskPanel(taskId);
              await loadProject(selectedProject, selectedCanvasId);
            }
            return;
          }
          const targetTaskId =
            selectedBlock?.taskId ?? selectedTaskPanelId ?? graph?.tasks[0]?.taskId;
          if (!targetTaskId) {
            setError(t("selectTaskBeforeBlock"));
            return;
          }
          const blockId = nextClientBlockId(graph, targetTaskId, type);
          const ok = await submitSharedPackageIntent(
            workspaceCanvas,
            {
              kind: "add_block",
              taskId: targetTaskId,
              blockId,
              blockType: type,
              title: defaultBlockTitleForUi(type, t),
              promptMarkdown: `# ${defaultBlockTitleForUi(type, t)}\n`,
              executor: settings.defaultExecutor.trim() || undefined
            },
            setError
          );
          if (ok) await loadProject(selectedProject, selectedCanvasId);
          return;
        }
        if (!bridge) return;
        const canvas = desktopCanvasReference(selectedProject, selectedCanvasId);
        if (type === "task") {
          const result = await bridge.addTaskNode(canvas, {
            title: t("defaultTaskTitle"),
            promptMarkdown: t("defaultTaskPrompt"),
            acceptance: [t("defaultTaskAcceptance")],
            blockTypes: visibleBlockSet(settings),
            executor: settings.defaultExecutor.trim() || null,
            layoutPosition: dropPosition ? { x: dropPosition.x, y: dropPosition.y } : undefined
          });
          if (!result.ok) {
            setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
            return;
          }
          const createdTaskId =
            result.affectedTasks.find(
              (taskId) => !graph?.tasks.some((task) => task.taskId === taskId)
            ) ??
            result.affectedTasks[0] ??
            null;
          if (createdTaskId) {
            selectTaskPanel(createdTaskId);
          }
          await loadProject(selectedProject, selectedCanvasId);
          return;
        }
        const targetTaskId =
          selectedBlock?.taskId ?? selectedTaskPanelId ?? graph?.tasks[0]?.taskId;
        if (!targetTaskId) {
          setError(t("selectTaskBeforeBlock"));
          return;
        }
        const result = await bridge.addBlock(canvas, {
          taskId: targetTaskId,
          type,
          title: defaultBlockTitleForUi(type, t),
          promptMarkdown: `# ${defaultBlockTitleForUi(type, t)}\n`,
          executor: settings.defaultExecutor.trim() || null
        });
        if (!result.ok) {
          setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
          return;
        }
        await loadProject(selectedProject, selectedCanvasId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      graph,
      loadProject,
      selectedBlock,
      selectedCanvasId,
      selectedProject,
      selectedTaskPanelId,
      setError,
      selectTaskPanel,
      settings,
      workspaceCanvas,
      t
    ]
  );

  const handlePaletteDragStart = useCallback(
    (event: React.DragEvent, type: PaletteDropComponent) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-planweave-palette", type);
    },
    []
  );

  const handleGraphDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes("application/x-planweave-palette")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleGraphDrop = useCallback(
    (event: React.DragEvent) => {
      const type = event.dataTransfer.getData(
        "application/x-planweave-palette"
      ) as PaletteDropComponent;
      if (!type) {
        return;
      }
      event.preventDefault();
      const dropPosition = flowInstance?.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      });
      void addPaletteComponent(type, type === "task" ? dropPosition : undefined);
    },
    [addPaletteComponent, flowInstance]
  );

  return {
    addPaletteComponent,
    handleConnect,
    handleEdgesDelete,
    handleReconnectEdge,
    handleGraphDragOver,
    handleGraphDrop,
    handleNodeDragStop,
    handlePaletteDragStart,
    resetLayout
  };
}
