export type NotificationScope = {
  projectRoot: string;
  canvasId: string | null;
};

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
  return `${kind}:v2:${JSON.stringify([scope.projectRoot, scope.canvasId, ...eventIdentity])}`;
}

export function collaborationNotificationIdentity(
  kind: "collab-activity" | "collab-mutation",
  scope: { profileId: string; projectId: string; canvasId: string | null },
  ...eventIdentity: readonly string[]
): string {
  return `${kind}:v2:${JSON.stringify([scope.profileId, scope.projectId, scope.canvasId, ...eventIdentity])}`;
}
