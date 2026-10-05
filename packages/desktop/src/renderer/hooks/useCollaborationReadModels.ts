import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { collaborationBridge } from "../bridge";
import { toCollaborationReadBridge } from "../collaboration/collaborationReadBridge";
import { acquireCollaborationReadModelController } from "../collaboration/collaborationReadModelHub";
import {
  buildCollaborationProjectViewModel,
  type CollaborationProjectViewModel,
  type LocalRuntimeWorkItemFacts
} from "../collaboration/collaborationViewModels";
import type {
  CollaborationReadBridgePort,
  CollaborationReadModelController
} from "../collaboration/CollaborationReadModelController";
import type { CollaborationReadModelSnapshot } from "../../shared/collaborationReadModels.js";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";

export type UseCollaborationReadModelsArgs = {
  profileId: string | null;
  projectId: string | null;
  canvasId?: string | null;
  /**
   * When true, this hook owns hub setActiveProject/clear binding.
   * Only the project shell (useCollaborationSurface) should enable this so
   * People/Assignee consumers can subscribe without thrashing canvas filter
   * or clearing shared assignment projections.
   * Isolated tests that need binding should pass true explicitly.
   * @default false
   */
  manageActiveProject?: boolean;
  /** Optional local Runtime facts merged only in view-model functions. */
  localWorkItems?: readonly LocalRuntimeWorkItemFacts[];
  /**
   * Injected read port or full collaboration API.
   * Defaults to the shared renderer collaboration bridge.
   */
  api?: CollaborationReadBridgePort | PlanWeaveCollaborationApi | null;
};

export type UseCollaborationReadModelsResult = {
  snapshot: CollaborationReadModelSnapshot;
  viewModel: CollaborationProjectViewModel;
  controller: CollaborationReadModelController | null;
};

function isFullCollaborationApi(
  api: CollaborationReadBridgePort | PlanWeaveCollaborationApi
): api is PlanWeaveCollaborationApi {
  return "upsertCollaborationProfile" in api;
}

function resolveReadPort(
  api: CollaborationReadBridgePort | PlanWeaveCollaborationApi | null | undefined
): CollaborationReadBridgePort | null {
  if (api === undefined) {
    return toCollaborationReadBridge(collaborationBridge);
  }
  if (api === null) return null;
  if (isFullCollaborationApi(api)) {
    return toCollaborationReadBridge(api);
  }
  return api;
}

/**
 * Shared collaboration read-model subscription for the active project.
 * Controllers are hub-shared per read port so people, assignee, and surfaces
 * never open duplicate observers. Components must not open additional observer connections.
 */
export function useCollaborationReadModels(
  args: UseCollaborationReadModelsArgs
): UseCollaborationReadModelsResult {
  const api = resolveReadPort(args.api);

  const controllerRef = useRef<CollaborationReadModelController | null>(null);
  const [controllerVersion, setControllerVersion] = useState(0);

  useEffect(() => {
    if (!api) {
      controllerRef.current = null;
      setControllerVersion((value) => value + 1);
      return;
    }

    const acquired = acquireCollaborationReadModelController(api);
    controllerRef.current = acquired.controller;
    setControllerVersion((value) => value + 1);

    return () => {
      acquired.release();
      if (controllerRef.current === acquired.controller) {
        controllerRef.current = null;
      }
    };
  }, [api]);

  // controllerVersion rebinds after hub acquire without capturing the controller instance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: controllerVersion is the rebind signal
  useEffect(() => {
    if (!args.manageActiveProject) return;
    const controller = controllerRef.current;
    if (!controller) return;
    if (!args.profileId || !args.projectId) {
      controller.clear();
      return;
    }
    void controller.setActiveProject({
      profileId: args.profileId,
      projectId: args.projectId,
      canvasId: args.canvasId
    });
    // controllerVersion rebinds after hub acquire without capturing the controller instance.
  }, [args.manageActiveProject, args.profileId, args.projectId, args.canvasId, controllerVersion]);

  const controller = controllerRef.current;
  const snapshot = useSyncExternalStore(
    (onStoreChange) => {
      if (!controller) return () => undefined;
      return controller.subscribe(onStoreChange);
    },
    () => controller?.getSnapshot() ?? idleSnapshot(),
    () => idleSnapshot()
  );

  const viewModel = useMemo(
    () =>
      buildCollaborationProjectViewModel({
        snapshot,
        localWorkItems: args.localWorkItems
      }),
    [snapshot, args.localWorkItems]
  );

  return { snapshot, viewModel, controller };
}

const IDLE_SNAPSHOT: CollaborationReadModelSnapshot = {
  profileId: null,
  projectId: null,
  canvasId: null,
  syncPhase: "idle",
  observerCursor: 0,
  members: [],
  hosts: [],
  assignmentsByWorkItem: {},
  workAuthorityByWorkItem: {},
  commentsByWorkItem: {},
  commentInvalidationVersionByWorkItem: {},
  activity: [],
  remoteRunsByDispatchId: {},
  mutationsById: {},
  lastError: null,
  loadingKinds: [],
  updatedAt: new Date(0).toISOString()
};

function idleSnapshot(): CollaborationReadModelSnapshot {
  return IDLE_SNAPSHOT;
}
