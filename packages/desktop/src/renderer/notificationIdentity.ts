import type { WorkspaceCanvasLocator } from "../shared/canvasLocator";

export type LocalNotificationScope = {
  projectRoot: string;
  canvasId: string | null;
};

export type NotificationScope = LocalNotificationScope | WorkspaceCanvasLocator;

export type NotificationNavigationContext =
  | { projectRoot: string; canvasId: string }
  | WorkspaceCanvasLocator;

export function notificationIdentity(
  kind:
    | "auto-run-error"
    | "latest-record"
    | "exception"
    | "dirty"
    | "prompt-conflict"
    | "file-change"
    | "sync",
  scope: NotificationScope,
  ...eventIdentity: readonly string[]
): string {
  if ("kind" in scope) {
    return `${kind}:workspace:v1:${JSON.stringify([
      scope.connectionProfileId,
      scope.workspaceId,
      scope.projectId,
      scope.canvasId,
      ...eventIdentity
    ])}`;
  }
  return `${kind}:v2:${JSON.stringify([scope.projectRoot, scope.canvasId, ...eventIdentity])}`;
}

export function collaborationNotificationIdentity(
  kind: "collab-activity" | "collab-mutation",
  scope: { profileId: string; projectId: string; canvasId: string | null },
  ...eventIdentity: readonly string[]
): string {
  return `${kind}:v2:${JSON.stringify([scope.profileId, scope.projectId, scope.canvasId, ...eventIdentity])}`;
}
