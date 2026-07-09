import type {
  GraphEditOperation,
  ManifestEdge,
  ManifestNode,
  PlanPackageManifest
} from "../../types.js";

function edgeKey(edge: ManifestEdge): string {
  return `${edge.from}\u0000${edge.type}\u0000${edge.to}`;
}

function nodeKey(node: ManifestNode): string {
  return JSON.stringify(node);
}

export function diffManifestToGraphOps(
  before: PlanPackageManifest,
  after: PlanPackageManifest
): GraphEditOperation[] {
  const operations: GraphEditOperation[] = [];
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));

  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) {
      operations.push({ type: "remove_node", nodeId: node.id });
    }
  }
  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id);
    if (!previous) {
      operations.push({ type: "add_node", node });
    } else if (nodeKey(previous) !== nodeKey(node)) {
      operations.push({ type: "update_node", node });
    }
  }

  const beforeEdges = new Map(before.edges.map((edge) => [edgeKey(edge), edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));
  for (const edge of before.edges) {
    if (!afterEdges.has(edgeKey(edge))) {
      operations.push({ type: "remove_edge", edge });
    }
  }
  for (const edge of after.edges) {
    if (!beforeEdges.has(edgeKey(edge))) {
      operations.push({ type: "add_edge", edge });
    }
  }
  return operations;
}
