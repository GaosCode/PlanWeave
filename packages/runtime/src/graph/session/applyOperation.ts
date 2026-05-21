import type { ExecutionGraphSession, GraphEditOperation, ValidationIssue } from "../../types.js";
import {
  addEdgeIndexes,
  addTaskIndexes,
  alignGraphOrder,
  issue,
  removeDirtyRefs,
  removeEdgeIndexes,
  removeTaskIndexes,
  sameEdge,
  validateEdge,
  validateTaskBlocks
} from "./graphIndexes.js";

export function applyGraphEditOperation(session: ExecutionGraphSession, operation: GraphEditOperation): ValidationIssue[] {
  const graph = session.graph;
  const manifest = session.fileSnapshot.manifest;
  if (operation.type === "update_prompt") {
    const taskId = graph.blockTaskByRef.get(operation.ref);
    if (!taskId) {
      return [issue("block_missing", `Block '${operation.ref}' does not exist.`, operation.ref)];
    }
    session.dirtyPromptRefs.add(operation.ref);
    return [];
  }
  if (operation.type === "add_node") {
    if (graph.nodesById.has(operation.node.id)) {
      return [issue("node_id_duplicate", `Node '${operation.node.id}' already exists.`, "nodes")];
    }
    if (operation.node.type === "task") {
      const diagnostics = validateTaskBlocks(operation.node);
      if (diagnostics.length > 0) {
        return diagnostics;
      }
    }
    manifest.nodes.push(operation.node);
    graph.nodesById.set(operation.node.id, operation.node);
    if (operation.node.type === "task") {
      addTaskIndexes(graph, operation.node);
      for (const ref of graph.blocksByTask.get(operation.node.id) ?? []) {
        session.dirtyPromptRefs.add(ref);
      }
    }
    return [];
  }
  if (operation.type === "update_node") {
    const index = manifest.nodes.findIndex((node) => node.id === operation.node.id);
    if (index < 0) {
      return [issue("node_missing", `Node '${operation.node.id}' does not exist.`, "nodes")];
    }
    if (operation.node.type === "task") {
      const diagnostics = validateTaskBlocks(operation.node);
      if (diagnostics.length > 0) {
        return diagnostics;
      }
    }
    const previous = manifest.nodes[index];
    let removedRefs: string[] = [];
    if (previous.type === "task") {
      removedRefs = removeTaskIndexes(graph, previous.id);
    }
    manifest.nodes[index] = operation.node;
    graph.nodesById.set(operation.node.id, operation.node);
    if (operation.node.type === "task") {
      removeDirtyRefs(session, removedRefs);
      addTaskIndexes(graph, operation.node);
      alignGraphOrder(graph, manifest);
      for (const ref of graph.blocksByTask.get(operation.node.id) ?? []) {
        session.dirtyPromptRefs.add(ref);
      }
    }
    return [];
  }
  if (operation.type === "remove_node") {
    const node = graph.nodesById.get(operation.nodeId);
    if (!node) {
      return [issue("node_missing", `Node '${operation.nodeId}' does not exist.`, "nodes")];
    }
    const removedEdges = manifest.edges.filter((edge) => edge.from === operation.nodeId || edge.to === operation.nodeId);
    manifest.edges = manifest.edges.filter((edge) => edge.from !== operation.nodeId && edge.to !== operation.nodeId);
    for (const edge of removedEdges) {
      removeEdgeIndexes(graph, edge);
    }
    manifest.nodes = manifest.nodes.filter((item) => item.id !== operation.nodeId);
    if (node.type === "task") {
      removeDirtyRefs(session, removeTaskIndexes(graph, node.id));
    } else {
      graph.nodesById.delete(node.id);
    }
    return [];
  }
  if (operation.type === "add_edge") {
    if (manifest.edges.some((edge) => sameEdge(edge, operation.edge))) {
      return [issue("edge_duplicate", "Edge already exists.", "edges")];
    }
    const diagnostics = validateEdge(graph, operation.edge);
    if (diagnostics.length > 0) {
      return diagnostics;
    }
    manifest.edges.push(operation.edge);
    addEdgeIndexes(graph, operation.edge);
    return [];
  }
  if (operation.type === "remove_edge") {
    const index = manifest.edges.findIndex((edge) => sameEdge(edge, operation.edge));
    if (index >= 0) {
      manifest.edges.splice(index, 1);
      removeEdgeIndexes(graph, operation.edge);
    }
  }
  return [];
}
