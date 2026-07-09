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

export function dependencyEdgeColorForSource(sourceId: string): string {
  return dependencyEdgeSourcePalette[stablePaletteIndex(sourceId)];
}

export function dependencyEdgeSourceColors(nodeIds: string[], links: DependencyEdgeLink[]): Map<string, string> {
  const adjacency = new Map(nodeIds.map((nodeId) => [nodeId, new Set<string>()]));
  for (const link of links) {
    adjacency.get(link.source)?.add(link.target);
    adjacency.get(link.target)?.add(link.source);
  }
  const assigned = new Map<string, string>();
  for (const nodeId of nodeIds) {
    const unavailable = new Set([...adjacency.get(nodeId) ?? []].flatMap((adjacentId) => {
      const color = assigned.get(adjacentId);
      return color ? [color] : [];
    }));
    const baseIndex = stablePaletteIndex(nodeId);
    let selected = dependencyEdgeSourcePalette[baseIndex];
    for (let offset = 0; offset < dependencyEdgeSourcePalette.length; offset += 1) {
      const candidate = dependencyEdgeSourcePalette[(baseIndex + offset) % dependencyEdgeSourcePalette.length];
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
  if (data && typeof data === "object" && "sourceColor" in data && typeof data.sourceColor === "string") {
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

function stablePaletteIndex(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash % dependencyEdgeSourcePalette.length;
}
