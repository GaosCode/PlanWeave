import type { Connection, Edge } from "@xyflow/react";
import type { DesktopGraphEdgeViewModel } from "@planweave-ai/runtime";

export type ManifestDependencyEndpoints = {
  from: string;
  to: string;
};

export type DisplayEdgeManifestData = {
  manifestEdgeType: DesktopGraphEdgeViewModel["type"];
  manifestFrom: string;
  manifestTo: string;
};

export function executionFlowEndpoints(edge: DesktopGraphEdgeViewModel): {
  source: string;
  target: string;
} {
  if (edge.type === "depends_on") {
    return { source: edge.to, target: edge.from };
  }
  return { source: edge.from, target: edge.to };
}

export function displayEdgeManifestData(edge: DesktopGraphEdgeViewModel): DisplayEdgeManifestData {
  return {
    manifestEdgeType: edge.type,
    manifestFrom: edge.from,
    manifestTo: edge.to
  };
}

export function dependencyConnectionToManifestEndpoints(
  connection: Connection
): ManifestDependencyEndpoints | null {
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return null;
  }
  return {
    from: connection.target,
    to: connection.source
  };
}

export function dependencyDisplayEdgeToManifestEndpoints(
  edge: Edge
): ManifestDependencyEndpoints | null {
  const data = edge.data as Partial<DisplayEdgeManifestData> | undefined;
  if (data?.manifestEdgeType && data.manifestEdgeType !== "depends_on") {
    return null;
  }
  if (data?.manifestEdgeType === "depends_on" && data.manifestFrom && data.manifestTo) {
    return {
      from: data.manifestFrom,
      to: data.manifestTo
    };
  }
  if (!edge.source || !edge.target || edge.source === edge.target) {
    return null;
  }
  return {
    from: edge.target,
    to: edge.source
  };
}
