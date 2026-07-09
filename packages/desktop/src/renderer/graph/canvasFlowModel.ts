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
  const visibleEdges = graph.edges.filter(
    (edge) => canvasIds.has(edge.from) && canvasIds.has(edge.to)
  );
  const sourceColors = dependencyEdgeSourceColors(
    graph.canvases.map((canvas) => canvas.canvasId),
    visibleEdges.map((edge) => ({ source: edge.to, target: edge.from }))
  );
  return visibleEdges.map((edge) => {
    const health = healthByEdge.get(`${edge.from}:${edge.type}:${edge.to}`) ?? null;
    const sourceColor = sourceColors.get(edge.to) ?? dependencyEdgeColorForSource(edge.to);
    return {
      id: `${edge.from}-${edge.type}-${edge.to}`,
      source: edge.to,
      target: edge.from,
      data: {
        health,
        manifestEdgeType: edge.type,
        manifestFrom: edge.from,
        manifestTo: edge.to
      } satisfies DisplayCanvasEdgeData,
      animated: false,
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
