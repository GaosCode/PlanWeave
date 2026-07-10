import { MarkerType, type Edge } from "@xyflow/react";
import type {
  DesktopCanvasGraphEdgeViewModel,
  DesktopCanvasGraphViewModel,
  DesktopCanvasHealthEdgeSummary,
  DesktopCanvasMapLayout
} from "@planweave-ai/runtime";
import type { CanvasFlowNode, CanvasNodeData } from "../types";
import { CanvasNodeCard } from "./CanvasNodeCard";
import {
  dependencyEdgeColorForSource,
  dependencyEdgeDefaultOpacity,
  dependencyEdgeSourceColors
} from "./dependencyEdgeVisual";

type DisplayCanvasDependency = DesktopCanvasGraphEdgeViewModel & {
  origin: "canvas" | "cross_task";
};

function canvasDependencyKey(edge: DesktopCanvasGraphEdgeViewModel): string {
  return `${edge.from}:${edge.type}:${edge.to}`;
}

function visibleCanvasDependencies(
  graph: DesktopCanvasGraphViewModel,
  canvasIds: Set<string>
): DisplayCanvasDependency[] {
  const canvasEdges = graph.edges
    .filter((edge) => canvasIds.has(edge.from) && canvasIds.has(edge.to))
    .map((edge) => ({ ...edge, origin: "canvas" as const }));
  const seen = new Set(canvasEdges.map(canvasDependencyKey));
  const crossTaskEdges: DisplayCanvasDependency[] = [];

  for (const edge of graph.crossTaskEdges) {
    const canvasEdge = {
      from: edge.from.canvasId,
      to: edge.to.canvasId,
      type: edge.type
    } satisfies DesktopCanvasGraphEdgeViewModel;
    const key = canvasDependencyKey(canvasEdge);
    const belongsToCanvasMap = canvasIds.has(canvasEdge.from) && canvasIds.has(canvasEdge.to);
    if (belongsToCanvasMap && !seen.has(key)) {
      seen.add(key);
      crossTaskEdges.push({ ...canvasEdge, origin: "cross_task" });
    }
  }

  return [...canvasEdges, ...crossTaskEdges];
}

export const canvasNodeTypes = {
  canvas: CanvasNodeCard
};

export type CanvasNodeTypes = typeof canvasNodeTypes;

export type DisplayCanvasEdgeData = {
  health: DesktopCanvasHealthEdgeSummary | null;
  manifestEdgeType: DesktopCanvasGraphEdgeViewModel["type"];
  manifestFrom: string;
  manifestTo: string;
};

export function canvasMapNodes(
  graph: DesktopCanvasGraphViewModel,
  layout: DesktopCanvasMapLayout | null,
  labels: CanvasNodeData["labels"],
  selectedCanvasId: string | null,
  onCanvasOpen: (canvasId: string) => void,
  onAgentPromptCopy: CanvasNodeData["onAgentPromptCopy"],
  onCanvasReveal: CanvasNodeData["onRevealInFinder"],
  onCanvasRename: CanvasNodeData["onRename"],
  onCanvasSelect: (canvasId: string) => void
): CanvasFlowNode[] {
  const layoutByCanvas = new Map(layout?.nodes.map((node) => [node.canvasId, node]) ?? []);
  const healthByCanvas = new Map(graph.health.canvases.map((canvas) => [canvas.canvasId, canvas]));
  return graph.canvases.map((canvas, index) => {
    const saved = layoutByCanvas.get(canvas.canvasId);
    return {
      id: canvas.canvasId,
      type: "canvas",
      position: saved
        ? { x: saved.x, y: saved.y }
        : { x: 80 + (index % 3) * 380, y: 80 + Math.floor(index / 3) * 220 },
      data: {
        canvas,
        health: healthByCanvas.get(canvas.canvasId) ?? null,
        labels,
        selected: selectedCanvasId === canvas.canvasId,
        onOpen: onCanvasOpen,
        onAgentPromptCopy,
        onRevealInFinder: onCanvasReveal,
        onRename: onCanvasRename,
        onSelect: onCanvasSelect
      }
    };
  });
}

export function canvasMapEdges(graph: DesktopCanvasGraphViewModel): Edge[] {
  const canvasIds = new Set(graph.canvases.map((canvas) => canvas.canvasId));
  const healthByEdge = new Map(
    graph.health.edges.map((edge) => [`${edge.from}:${edge.type}:${edge.to}`, edge])
  );
  const visibleEdges = visibleCanvasDependencies(graph, canvasIds);
  const sourceColors = dependencyEdgeSourceColors(
    graph.canvases.map((canvas) => canvas.canvasId),
    visibleEdges.map((edge) => ({ source: edge.to, target: edge.from }))
  );
  return visibleEdges.map((edge) => {
    const health = healthByEdge.get(`${edge.from}:${edge.type}:${edge.to}`) ?? null;
    const sourceColor = sourceColors.get(edge.to) ?? dependencyEdgeColorForSource(edge.to);
    const isCanvasEdge = edge.origin === "canvas";
    let edgeId = `${edge.from}-${edge.type}-${edge.to}`;
    if (!isCanvasEdge) {
      edgeId = `cross-task-${edgeId}`;
    }
    return {
      id: edgeId,
      source: edge.to,
      target: edge.from,
      data: {
        health,
        manifestEdgeType: edge.type,
        manifestFrom: edge.from,
        manifestTo: edge.to
      } satisfies DisplayCanvasEdgeData,
      animated: false,
      selectable: isCanvasEdge,
      type: "smoothstep",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: sourceColor,
        width: 18,
        height: 18
      },
      style: {
        stroke: sourceColor,
        strokeWidth: 2.2,
        opacity: dependencyEdgeDefaultOpacity,
        transition: "opacity 120ms ease, stroke-width 120ms ease"
      }
    } satisfies Edge;
  });
}
