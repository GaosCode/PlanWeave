import type { HumanObserverEvent } from "@planweave-ai/collaboration-protocol/activity/observer";
import type { ProjectAccessRepository } from "./projectAccessRepository.js";

const PROJECT_WIDE_OBSERVER_KINDS = new Set<HumanObserverEvent["kind"]>([
  "membership",
  "invitation",
  "project"
]);

const CANVAS_LIST_PAGE = 100;

export type HumanObserverEventVisibility =
  | { kind: "project" }
  | { kind: "canvases"; canvasIds: ReadonlySet<string> }
  | { kind: "none" };

export function loadHumanObserverEventVisibility(input: {
  projectAccess: ProjectAccessRepository;
  workspaceId: string;
  projectId: string;
  humanPrincipalId: string;
}): HumanObserverEventVisibility {
  const actor = { kind: "human" as const, id: input.humanPrincipalId };
  try {
    const project = input.projectAccess.evaluateEffectiveAccess({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actor
    });
    if (project.capabilities.read) return { kind: "project" };
  } catch {
    return { kind: "none" };
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
  if (visibility.kind === "project") return true;
  if (visibility.kind === "none") return false;
  if (PROJECT_WIDE_OBSERVER_KINDS.has(event.kind)) return true;
  const canvasId = event.canvasId ?? event.workItem?.canvasId;
  return typeof canvasId === "string" && visibility.canvasIds.has(canvasId);
}
