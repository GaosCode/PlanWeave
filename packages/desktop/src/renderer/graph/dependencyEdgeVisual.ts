import type { Edge } from "@xyflow/react";

export const dependencyEdgeDefaultOpacity = 0.56;
export const dependencyEdgeHighlightedOpacity = 0.96;
export const dependencyEdgeDimmedOpacity = 0.12;

export const dependencyEdgeSourcePalette = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#9333ea",
  "#0891b2",
  "#ca8a04",
  "#db2777",
  "#4f46e5",
  "#059669",
  "#ea580c"
];

export type DependencyEdgeLink = {
  source: string;
  target: string;
};

export type DependencyEdgeInteraction = {
  hoveredEdgeId?: string | null;
  hoveredNodeId?: string | null;
};

export function dependencyEdgeColorForSource(sourceId: string): string {
  return dependencyEdgeSourcePalette[stablePaletteIndex(sourceId)];
}

export function dependencyEdgeSourceColors(
  nodeIds: string[],
  links: DependencyEdgeLink[]
): Map<string, string> {
  const adjacency = new Map(nodeIds.map((nodeId) => [nodeId, new Set<string>()]));
  for (const link of links) {
    adjacency.get(link.source)?.add(link.target);
    adjacency.get(link.target)?.add(link.source);
  }
  const assigned = new Map<string, string>();
  for (const nodeId of nodeIds) {
    const unavailable = new Set(
      [...(adjacency.get(nodeId) ?? [])].flatMap((adjacentId) => {
        const color = assigned.get(adjacentId);
        return color ? [color] : [];
      })
    );
    const baseIndex = stablePaletteIndex(nodeId);
    let selected = dependencyEdgeSourcePalette[baseIndex];
    for (let offset = 0; offset < dependencyEdgeSourcePalette.length; offset += 1) {
      const candidate =
        dependencyEdgeSourcePalette[(baseIndex + offset) % dependencyEdgeSourcePalette.length];
      if (!unavailable.has(candidate)) {
        selected = candidate;
        break;
      }
    }
    assigned.set(nodeId, selected);
  }
  return assigned;
}

export function dependencyEdgeColor(edge: Edge): string {
  const data = edge.data;
  if (
    data &&
    typeof data === "object" &&
    "sourceColor" in data &&
    typeof data.sourceColor === "string"
  ) {
    return data.sourceColor;
  }
  const stroke = edge.style?.stroke;
  return typeof stroke === "string" ? stroke : dependencyEdgeSourcePalette[0];
}

export function markerEndWithColor(markerEnd: Edge["markerEnd"], color: string): Edge["markerEnd"] {
  if (!markerEnd || typeof markerEnd !== "object") {
    return markerEnd;
  }
  return { ...markerEnd, color };
}

export function styleDependencyEdgesForInteraction(
  edges: Edge[],
  interaction: DependencyEdgeInteraction
): Edge[] {
  const hoveredNodeId = interaction.hoveredNodeId ?? null;
  const hoveredEdgeId = interaction.hoveredEdgeId ?? null;
  const selectedEdgeIds = new Set(edges.filter((edge) => edge.selected).map((edge) => edge.id));
  const hasHoveredNode =
    hoveredNodeId !== null &&
    edges.some((edge) => edge.source === hoveredNodeId || edge.target === hoveredNodeId);
  const hasSelectedEdge = selectedEdgeIds.size > 0;
  const hasHoveredEdge =
    !hasSelectedEdge && hoveredEdgeId !== null && edges.some((edge) => edge.id === hoveredEdgeId);
  const hasInteraction = hasHoveredNode || hasHoveredEdge || hasSelectedEdge;
  return edges.map((edge) => {
    const relatedToSelection = selectedEdgeIds.has(edge.id);
    const lockedBySelection = hasSelectedEdge && !relatedToSelection;
    const relatedToNode =
      !hasSelectedEdge &&
      hasHoveredNode &&
      (edge.source === hoveredNodeId || edge.target === hoveredNodeId);
    const relatedToEdge = hasHoveredEdge && edge.id === hoveredEdgeId;
    const related = !hasInteraction || relatedToNode || relatedToEdge || relatedToSelection;
    const highlighted = relatedToNode || relatedToEdge || relatedToSelection;
    const color = dependencyEdgeColor(edge);
    return {
      ...edge,
      ...(lockedBySelection
        ? { interactionWidth: 1, reconnectable: false, selectable: false }
        : {}),
      markerEnd: markerEndWithColor(edge.markerEnd, color),
      style: {
        ...edge.style,
        stroke: color,
        strokeWidth: highlighted ? 3.2 : related ? (edge.style?.strokeWidth ?? 2) : 1.4,
        opacity: highlighted
          ? dependencyEdgeHighlightedOpacity
          : related
            ? (edge.style?.opacity ?? dependencyEdgeDefaultOpacity)
            : dependencyEdgeDimmedOpacity
      }
    };
  });
}

function stablePaletteIndex(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash % dependencyEdgeSourcePalette.length;
}
