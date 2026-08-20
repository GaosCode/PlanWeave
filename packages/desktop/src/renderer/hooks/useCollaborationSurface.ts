import { useEffect, useMemo, useState } from "react";
import { collaborationBridge } from "../bridge";
import {
  buildAssigneeSurfaceIndex,
  buildCollaborationNotificationDrafts,
  type AssigneeSurfaceIndex
} from "../collaboration/assigneeSurfaceViewModels";
import { assigneeDisplayLabelsFromTranslator } from "../collaboration/assignmentViewModels";
import type { CollaborationProjectViewModel } from "../collaboration/collaborationViewModels";
import type { CollaborationReadModelController } from "../collaboration/CollaborationReadModelController";
import type { createTranslator } from "../i18n";
import type { CollaborationReadModelSnapshot } from "../../shared/collaborationReadModels.js";
import {
  isLocalCollaborationProfileId,
  type CollaborationStatus,
  type CollaborationCanvasBindingInput,
  type LocalCollaborationServerStatus,
  type PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";

export type UseCollaborationSurfaceArgs = {
  binding?: CollaborationCanvasBindingInput | null;
  /** Active local canvas id (filters assignment pages when set). */
  canvasId?: string | null;
  /** Active local package project id, used to prevent cross-project Workspace reads. */
  localProjectId?: string | null;
  api?: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
};

export type UseCollaborationSurfaceResult = {
  status: CollaborationStatus | null;
  snapshot: CollaborationReadModelSnapshot;
  viewModel: CollaborationProjectViewModel;
  controller: CollaborationReadModelController | null;
  assigneeIndex: AssigneeSurfaceIndex;
  activeProfileId: string | null;
  activeProjectId: string | null;
  sessionConnected: boolean;
  localOwnerDirectWriteAvailable: boolean;
  collaborationNotificationDrafts: ReturnType<typeof buildCollaborationNotificationDrafts>;
};

export function canUseLocalOwnerDirectWrites(
  profileId: string | null,
  lifecycle: Pick<LocalCollaborationServerStatus, "state" | "reason"> | null
): boolean {
  if (!profileId || !isLocalCollaborationProfileId(profileId)) return false;
  return (
    lifecycle?.state === "stopped" ||
    (lifecycle?.state === "error" && lifecycle.reason !== "stop_failed")
  );
}

export function resolveCollaborationSurfaceReadBinding(input: {
  sessionConnected: boolean;
  profileId: string | null;
  profileProjectId: string | null;
  localProjectId: string | null;
  canvasId: string | null;
}): { profileId: string | null; projectId: string | null; canvasId: string | null } {
  if (!input.sessionConnected || !input.profileId || !input.profileProjectId) {
    return { profileId: null, projectId: null, canvasId: null };
  }
  if (!input.localProjectId || input.localProjectId !== input.profileProjectId) {
    return { profileId: null, projectId: null, canvasId: null };
  }
  return {
    profileId: input.profileId,
    projectId: input.profileProjectId,
    canvasId: input.canvasId
  };
}

type CollaborationCanvasReadResolution = {
  localProjectId: string;
  localCanvasId: string;
  remoteProjectId: string;
  remoteCanvasId: string;
};

export function resolveCollaborationCanvasReadBinding(
  binding: { profileId: string | null; projectId: string | null; canvasId: string | null },
  resolution: CollaborationCanvasReadResolution | null
): { profileId: string | null; projectId: string | null; canvasId: string | null } {
  if (!binding.profileId || !binding.projectId) {
    return { profileId: null, projectId: null, canvasId: null };
  }
  if (binding.canvasId === null) return binding;
  if (
    !resolution ||
    resolution.localProjectId !== binding.projectId ||
    resolution.localCanvasId !== binding.canvasId ||
    resolution.remoteProjectId !== binding.projectId
  ) {
    return { profileId: null, projectId: null, canvasId: null };
  }
  return { ...binding, canvasId: resolution.remoteCanvasId };
}

/**
 * Single project-shell authority for compact assignee surfaces + activity notifications.
 * Detailed people/assignee panels remain on-demand; this hook only keeps the shared
 * membership/assignment/activity projections warm for the active collaboration project.
 */
export function useCollaborationSurface(
  args: UseCollaborationSurfaceArgs
): UseCollaborationSurfaceResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const { status } = useCollaborationStatus({ api });

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected = isCollaborationSessionConnected(status);
  const activeProfileIsLocal = activeProfile
    ? isLocalCollaborationProfileId(activeProfile.profileId)
    : false;
  const activeProfileRevision = activeProfile?.updatedAt ?? null;
  const [localServerLifecycle, setLocalServerLifecycle] = useState<Pick<
    LocalCollaborationServerStatus,
    "state" | "reason"
  > | null>(null);

  useEffect(() => {
    if (!api || !activeProfileIsLocal || !activeProfileRevision) {
      setLocalServerLifecycle(null);
      return undefined;
    }
    let active = true;
    void api
      .getLocalCollaborationServerStatus()
      .then((serverStatus) => {
        if (active) {
          setLocalServerLifecycle({ state: serverStatus.state, reason: serverStatus.reason });
        }
      })
      .catch(() => {
        if (active) setLocalServerLifecycle(null);
      });
    return () => {
      active = false;
    };
  }, [activeProfileIsLocal, activeProfileRevision, api]);

  const readBinding = resolveCollaborationSurfaceReadBinding({
    sessionConnected,
    profileId: activeProfile?.profileId ?? null,
    profileProjectId: activeProfile?.projectId ?? null,
    localProjectId: args.localProjectId ?? null,
    canvasId: args.canvasId ?? null
  });
  const remoteBinding = args.binding?.kind === "remote" ? args.binding : null;
  const remoteReadBinding = useMemo(
    () =>
      remoteBinding && sessionConnected && activeProfile?.projectId === remoteBinding.projectId
        ? {
            profileId: activeProfile.profileId,
            projectId: remoteBinding.projectId,
            canvasId: remoteBinding.canvasId
          }
        : null,
    [activeProfile, remoteBinding, sessionConnected]
  );
  const [canvasReadResolution, setCanvasReadResolution] =
    useState<CollaborationCanvasReadResolution | null>(null);

  useEffect(() => {
    if (
      remoteReadBinding ||
      !api ||
      !readBinding.profileId ||
      !readBinding.projectId ||
      readBinding.canvasId === null ||
      !args.localProjectId
    ) {
      setCanvasReadResolution(null);
      return undefined;
    }
    const localProjectId = args.localProjectId;
    const localCanvasId = readBinding.canvasId;
    const remoteProjectId = readBinding.projectId;
    let active = true;
    setCanvasReadResolution(null);
    void api
      .resolveCollaborationCanvasBindingScope({
        kind: "local",
        localProjectId,
        canvasId: localCanvasId
      })
      .then((scope) => {
        if (!active) return;
        setCanvasReadResolution(
          scope && scope.projectId === remoteProjectId
            ? {
                localProjectId,
                localCanvasId,
                remoteProjectId: scope.projectId,
                remoteCanvasId: scope.canvasId
              }
            : null
        );
      })
      .catch(() => {
        if (active) setCanvasReadResolution(null);
      });
    return () => {
      active = false;
    };
  }, [
    api,
    args.localProjectId,
    remoteReadBinding,
    readBinding.canvasId,
    readBinding.profileId,
    readBinding.projectId
  ]);

  const authorizedReadBinding =
    remoteReadBinding ?? resolveCollaborationCanvasReadBinding(readBinding, canvasReadResolution);

  // Shell is the sole owner of active project/canvas binding on the shared hub.
  const { snapshot, viewModel, controller } = useCollaborationReadModels({
    api,
    profileId: authorizedReadBinding.profileId,
    projectId: authorizedReadBinding.projectId,
    canvasId: authorizedReadBinding.canvasId,
    manageActiveProject: true
  });

  const assigneeLabels = useMemo(() => assigneeDisplayLabelsFromTranslator(args.t), [args.t]);

  const assigneeIndex = useMemo(
    () => buildAssigneeSurfaceIndex(snapshot, assigneeLabels),
    [assigneeLabels, snapshot]
  );

  const collaborationNotificationDrafts = useMemo(
    () =>
      buildCollaborationNotificationDrafts({
        activity: snapshot.activity,
        mutations: Object.values(snapshot.mutationsById),
        labels: {
          assignmentUpdated: args.t("notifyAssignmentUpdated"),
          assignmentFailed: args.t("notifyAssignmentFailed"),
          membershipChanged: args.t("notifyMembershipChanged"),
          mutationConfirmed: args.t("notifyAssignmentConfirmed"),
          mutationRejected: args.t("notifyAssignmentRejected")
        }
      }),
    [args.t, snapshot.activity, snapshot.mutationsById]
  );

  return {
    status,
    snapshot,
    viewModel,
    controller,
    assigneeIndex,
    // Keep the durable-write fence scoped while a selected collaboration profile is offline.
    // The read model still connects only after an authenticated session is available.
    activeProfileId: activeProfile?.profileId ?? null,
    activeProjectId: activeProfile?.projectId ?? null,
    sessionConnected,
    localOwnerDirectWriteAvailable: canUseLocalOwnerDirectWrites(
      activeProfile?.profileId ?? null,
      localServerLifecycle
    ),
    collaborationNotificationDrafts
  };
}
