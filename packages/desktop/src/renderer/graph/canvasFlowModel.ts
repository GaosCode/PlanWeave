import { MarkerType, type Edge } from "@xyflow/react";
import type { DesktopCanvasGraphEdgeViewModel, DesktopCanvasGraphViewModel, DesktopCanvasMapLayout } from "@planweave-ai/runtime";
import type { CanvasFlowNode, CanvasNodeData } from "../types";
import { CanvasNodeCard } from "./CanvasNodeCard";

export const canvasNodeTypes = {
  canvas: CanvasNodeCard
};

export type CanvasNodeTypes = typeof canvasNodeTypes;

export type DisplayCanvasEdgeData = {
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
  onCanvasSelect: (canvasId: string) => void
): CanvasFlowNode[] {
  const layoutByCanvas = new Map(layout?.nodes.map((node) => [node.canvasId, node]) ?? []);
  return graph.canvases.map((canvas, index) => {
    const saved = layoutByCanvas.get(canvas.canvasId);
    return {
      id: canvas.canvasId,
      type: "canvas",
      position: saved ? { x: saved.x, y: saved.y } : { x: 80 + (index % 3) * 380, y: 80 + Math.floor(index / 3) * 220 },
      data: {
        canvas,
        labels,
        selected: selectedCanvasId === canvas.canvasId,
        onOpen: onCanvasOpen,
        onSelect: onCanvasSelect
      }
    };
  });
}

export function canvasMapEdges(graph: DesktopCanvasGraphViewModel): Edge[] {
  const canvasIds = new Set(graph.canvases.map((canvas) => canvas.canvasId));
  return graph.edges
    .filter((edge) => canvasIds.has(edge.from) && canvasIds.has(edge.to))
    .map((edge) => {
      return {
        id: `${edge.from}-${edge.type}-${edge.to}`,
        source: edge.to,
        target: edge.from,
        data: {
          manifestEdgeType: edge.type,
          manifestFrom: edge.from,
          manifestTo: edge.to
        } satisfies DisplayCanvasEdgeData,
        animated: false,
        type: "smoothstep",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "#0f766e",
          width: 18,
          height: 18
        },
        style: {
          stroke: "#0f766e",
          strokeWidth: 2.4,
          opacity: 0.95
        }
      } satisfies Edge;
    });
}
