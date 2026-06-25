import type { ProjectCanvasEdge, ProjectCrossTaskEdge, ProjectTaskRef, ProjectTaskRefString } from "./types.js";

export function projectTaskRefKey(ref: ProjectTaskRef): ProjectTaskRefString {
  return `${ref.canvasId}::${ref.taskId}`;
}

export function parseProjectTaskRefKey(ref: ProjectTaskRefString): ProjectTaskRef {
  const separator = ref.indexOf("::");
  if (separator === -1) {
    throw new Error(`Invalid project task ref '${ref}'. Expected '<canvas-id>::<task-id>'.`);
  }
  if (separator === 0) {
    throw new Error(`Invalid project task ref '${ref}'. Expected '<canvas-id>::<task-id>'.`);
  }
  if (separator + 2 >= ref.length) {
    throw new Error(`Invalid project task ref '${ref}'. Expected '<canvas-id>::<task-id>'.`);
  }
  return {
    canvasId: ref.slice(0, separator),
    taskId: ref.slice(separator + 2)
  };
}

export function projectCanvasEdgeKey(edge: ProjectCanvasEdge): string {
  return `${edge.from}\u0000${edge.type}\u0000${edge.to}`;
}

export function projectCrossTaskEdgeKey(edge: ProjectCrossTaskEdge): string {
  return `${projectTaskRefKey(edge.from)}\u0000${edge.type}\u0000${projectTaskRefKey(edge.to)}`;
}
