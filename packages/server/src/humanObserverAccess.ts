import type { HumanObserverEvent } from "@planweave-ai/collaboration-protocol/activity/observer";
import type { ProjectAccessRepository } from "./projectAccessRepository.js";

const PROJECT_WIDE_OBSERVER_KINDS = new Set<HumanObserverEvent["kind"]>([
  "membership",
  "invitation",
  "project"
]);

const CANVAS_LIST_PAGE = 100;

export type HumanObserverEventVisibility =
  | { kind: "project"; canvasIds: ReadonlySet<string> }
  | { kind: "canvases"; canvasIds: ReadonlySet<string> }
  | { kind: "none" };

export function loadHumanObserverEventVisibility(input: {
  projectAccess: ProjectAccessRepository;
  workspaceId: string;
  projectId: string;
  humanPrincipalId: string;
}): HumanObserverEventVisibility {
  const actor = { kind: "human" as const, id: input.humanPrincipalId };
  let projectReadable = false;
  try {
    const project = input.projectAccess.evaluateEffectiveAccess({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actor
    });
    projectReadable = project.capabilities.read;
  } catch (error) {
    if (error instanceof Error && error.message === "access_scope_not_found")
      return { kind: "none" };
    throw error;
  }
  const canvasIds = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = input.projectAccess.listAuthorizedCanvases({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actor,
      limit: CANVAS_LIST_PAGE,
      offset
    });
    for (const canvas of page) canvasIds.add(canvas.registry.canvasId);
    if (page.length < CANVAS_LIST_PAGE) break;
    offset += page.length;
  }
  if (projectReadable) return { kind: "project", canvasIds };
  return canvasIds.size > 0 ? { kind: "canvases", canvasIds } : { kind: "none" };
}

export function humanCanObserveProject(input: {
  projectAccess: ProjectAccessRepository;
  workspaceId: string;
  projectId: string;
  humanPrincipalId: string;
}): boolean {
  return loadHumanObserverEventVisibility(input).kind !== "none";
}

export function humanObserverEventIsVisible(
  event: HumanObserverEvent,
  visibility: HumanObserverEventVisibility
): boolean {
  if (visibility.kind === "none") return false;
  if (PROJECT_WIDE_OBSERVER_KINDS.has(event.kind)) return visibility.kind === "project";
  // Historical item-scoped events without scope are not project-wide events.
  if (
    (event.kind === "remote_run" ||
      (event.kind === "activity" && event.dispatchId) ||
      (event.kind === "attachment" && event.commentId)) &&
    !event.workItem
  )
    return false;
  const canvasId = event.canvasId ?? event.workItem?.canvasId;
  return typeof canvasId === "string"
    ? visibility.canvasIds.has(canvasId)
    : visibility.kind === "project";
}
