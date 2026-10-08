import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AssignmentDisplayProjection,
  AssignmentTarget,
  EligibleAssigneesResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { collaborationBridge } from "../bridge";
import {
  assigneeDisplayLabelsFromTranslator,
  buildAssigneePickerViewModel,
  DEFAULT_ASSIGNEE_DISPLAY_LABELS,
  targetsEqual,
  type AssigneeDisplayLabels,
  type AssigneePickerViewModel
} from "../collaboration/assignmentViewModels";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import { workItemKey } from "../../shared/collaborationReadModels.js";
import type { createTranslator } from "../i18n";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";

/** Human responsibility and reviewer authorities shown in ordinary inspectors. */
export type AssigneeAuthorityRole = "responsibility" | "reviewer";

export type UseAssigneePickerControllerArgs = {
  workItem: WorkItemRef | null;
  /**
   * Which independent authority this picker mutates.
   * Defaults to responsibility (human owner). Reviewer never changes execution target.
   */
  authorityRole?: AssigneeAuthorityRole;
  api?: PlanWeaveCollaborationApi | null;
  /** When true, load eligible assignees (picker open). Default false for on-demand. */
  detailsOpen?: boolean;
  /** Translator for primary assignee labels (en / zh-CN catalog). */
  t?: ReturnType<typeof createTranslator>;
  /** Optional prebuilt labels; takes precedence over t when both are provided. */
  labels?: AssigneeDisplayLabels;
  /** Optional outcome callbacks for shell toasts / activity UX. */
  onAssignmentOutcome?: (outcome: {
    ok: boolean;
    workItem: WorkItemRef;
    target: AssignmentTarget;
    errorMessage?: string | null;
  }) => void;
};

export type UseAssigneePickerControllerResult = {
  viewModel: AssigneePickerViewModel | null;
  authority: WorkAuthorityProjection | null;
  authorityRole: AssigneeAuthorityRole;
  query: string;
  setQuery: (value: string) => void;
  selectTarget: (target: AssignmentTarget) => Promise<boolean>;
  refresh: () => Promise<void>;
  retryLastTarget: () => Promise<boolean>;
};

/**
 * Project independent authority into the legacy assignment display shape so section builders reuse.
 * Responsibility and reviewer map to human targets only.
 */
export function assignmentProjectionFromAuthority(input: {
  workItem: WorkItemRef;
  projectId: string;
  authority: WorkAuthorityProjection | null | undefined;
  role: AssigneeAuthorityRole;
}): AssignmentDisplayProjection | null {
  const authority = input.authority;
  if (!authority) return null;

  const human = input.role === "responsibility" ? authority.responsibility : authority.reviewer;
  const principal = human.principal;
  const availability =
    human.availability === "active"
      ? ({ status: "ready", reason: "ready" } as const)
      : human.availability === "unassigned"
        ? ({ status: "unassigned", reason: "unassigned" } as const)
        : ({ status: "invalid", reason: "human_membership_inactive" } as const);
  return {
    projectId: input.projectId,
    workItem: input.workItem,
    target: principal
      ? { kind: "human", humanPrincipalId: principal.humanPrincipalId }
      : { kind: "unassigned" },
    revision: human.revision,
    availability,
    ...(principal
      ? {
          human: {
            humanPrincipalId: principal.humanPrincipalId,
            displayName: principal.humanPrincipalId,
            membershipActive: human.availability === "active"
          }
        }
      : {})
  };
}

function filterEligibleForRole(
  eligible: EligibleAssigneesResponse | null
): EligibleAssigneesResponse | null {
  if (!eligible) return null;
  return {
    ...eligible,
    hosts: [],
    nextHostCursor: null
  };
}

/**
 * Task/Block authority picker controller.
 * Routes mutations to independent responsibility and reviewer CAS paths.
 */
export function useAssigneePickerController(
  args: UseAssigneePickerControllerArgs
): UseAssigneePickerControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const authorityRole: AssigneeAuthorityRole = args.authorityRole ?? "responsibility";
  const detailsOpen = args.detailsOpen ?? false;
  const { status } = useCollaborationStatus({ api });

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected = isCollaborationSessionConnected(status);

  // Subscribe only — project/canvas binding is owned by useCollaborationSurface.
  const {
    snapshot,
    viewModel: projectView,
    controller
  } = useCollaborationReadModels({
    api,
    profileId: sessionConnected ? (activeProfile?.profileId ?? null) : null,
    projectId: sessionConnected ? (activeProfile?.projectId ?? null) : null,
    canvasId: args.workItem?.canvasId ?? null,
    manageActiveProject: false
  });

  const labels = useMemo((): AssigneeDisplayLabels => {
    if (args.labels) return args.labels;
    if (args.t) return assigneeDisplayLabelsFromTranslator(args.t);
    return DEFAULT_ASSIGNEE_DISPLAY_LABELS;
  }, [args.labels, args.t]);

  const [eligible, setEligible] = useState<EligibleAssigneesResponse | null>(null);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [localStaleConflict, setLocalStaleConflict] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastAttemptedTarget, setLastAttemptedTarget] = useState<AssignmentTarget | null>(null);

  const mutationRequestRef = useRef(0);
  const eligibleRequestRef = useRef(0);
  const pendingRef = useRef(false);
  const workItemKeyValue = args.workItem ? workItemKey(args.workItem) : null;
  const onOutcomeRef = useRef(args.onAssignmentOutcome);
  onOutcomeRef.current = args.onAssignmentOutcome;
  const scopeToken = useMemo(
    () => ({
      api,
      controller,
      workItemKeyValue,
      authorityRole,
      sessionConnected,
      profileId: snapshot.profileId,
      projectId: snapshot.projectId,
      activeProfileId: activeProfile?.profileId,
      activeProjectId: activeProfile?.projectId,
      serverBaseUrl: activeProfile?.serverBaseUrl,
      workspaceId: status?.workspaceConnection.workspaceId,
      sessionProfileId: status?.session.activeProfileId
    }),
    [
      api,
      controller,
      workItemKeyValue,
      authorityRole,
      sessionConnected,
      snapshot.profileId,
      snapshot.projectId,
      activeProfile?.profileId,
      activeProfile?.projectId,
      activeProfile?.serverBaseUrl,
      status?.workspaceConnection.workspaceId,
      status?.session.activeProfileId
    ]
  );
  const currentScopeRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    currentScopeRef.current = scopeToken;
    setEligible(null);
    setEligibleLoading(false);
    setQuery("");
    setPending(false);
    pendingRef.current = false;
    setLocalStaleConflict(false);
    setActionError(null);
    setLastAttemptedTarget(null);
    return () => {
      currentScopeRef.current = null;
    };
  }, [scopeToken]);
  const isCurrentScope = useCallback(() => currentScopeRef.current === scopeToken, [scopeToken]);

  useEffect(() => {
    if (!detailsOpen) {
      setEligible(null);
      setEligibleLoading(false);
    }
  }, [detailsOpen]);

  // Load independent authority projection for the selected work item.
  useEffect(() => {
    if (!controller || !args.workItem || !sessionConnected || !isCurrentScope()) return;
    void controller.ensureWorkAuthority(args.workItem).catch(() => undefined);
  }, [args.workItem, controller, isCurrentScope, sessionConnected]);

  const loadEligible = useCallback(async () => {
    if (!isCurrentScope()) return;
    if (!api || !args.workItem || !sessionConnected) {
      setEligible(null);
      return;
    }
    const request = ++eligibleRequestRef.current;
    const isCurrentRequest = () => isCurrentScope() && request === eligibleRequestRef.current;
    setEligibleLoading(true);
    try {
      const page = await api.listCollaborationEligibleAssignees({ workItem: args.workItem });
      if (!isCurrentRequest()) return;
      setEligible(filterEligibleForRole(page));
    } catch (error) {
      if (!isCurrentRequest()) return;
      setActionError(collaborationErrorMessage(error));
      setEligible(null);
    } finally {
      if (isCurrentRequest()) {
        setEligibleLoading(false);
      }
    }
  }, [api, args.workItem, isCurrentScope, sessionConnected]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: workItemKeyValue remounts eligible load
  useEffect(() => {
    if (!detailsOpen || !sessionConnected || !args.workItem) return;
    void loadEligible();
  }, [args.workItem, authorityRole, detailsOpen, loadEligible, sessionConnected, workItemKeyValue]);

  const authority: WorkAuthorityProjection | null = useMemo(() => {
    if (!args.workItem) return null;
    return snapshot.workAuthorityByWorkItem[workItemKey(args.workItem)] ?? null;
  }, [args.workItem, snapshot.workAuthorityByWorkItem]);

  const projectId = activeProfile?.projectId ?? snapshot.projectId ?? "unknown";

  const assignment: AssignmentDisplayProjection | null = useMemo(() => {
    if (!args.workItem) return null;
    return assignmentProjectionFromAuthority({
      workItem: args.workItem,
      projectId,
      authority,
      role: authorityRole
    });
  }, [args.workItem, authority, authorityRole, projectId]);

  const refresh = useCallback(async () => {
    if (!isCurrentScope()) return;
    if (controller && args.workItem) {
      await controller.ensureWorkAuthority(args.workItem);
      if (!isCurrentScope()) return;
      await controller.refreshAuthoritative({ reason: "assignee_picker_refresh" });
    }
    if (!isCurrentScope()) return;
    if (detailsOpen) {
      await loadEligible();
      if (!isCurrentScope()) return;
    }
    setLocalStaleConflict(false);
    if (snapshot.syncPhase !== "stale_conflict") {
      setActionError(null);
    }
  }, [args.workItem, controller, detailsOpen, isCurrentScope, loadEligible, snapshot.syncPhase]);

  const performSelection = useCallback(
    async (target: AssignmentTarget, refreshBeforeSelection = false): Promise<boolean> => {
      if (!api || !args.workItem || !controller || !sessionConnected || !isCurrentScope())
        return false;
      if (pendingRef.current) return false;

      if (target.kind === "exact_host" || target.kind === "automatic_host") {
        const errorMessage = labels.taskDisallowsMachine;
        setActionError(errorMessage);
        setLastAttemptedTarget(target);
        onOutcomeRef.current?.({
          ok: false,
          workItem: args.workItem,
          target,
          errorMessage
        });
        return false;
      }

      pendingRef.current = true;
      setPending(true);
      setLastAttemptedTarget(target);
      setActionError(null);
      const request = ++mutationRequestRef.current;
      const isCurrentRequest = () => isCurrentScope() && request === mutationRequestRef.current;
      let mutationSucceeded = false;
      const workItem = args.workItem;

      try {
        if (refreshBeforeSelection) {
          await refresh();
          if (!isCurrentRequest()) return false;
        }
        const latestSnapshot = controller.getSnapshot();
        if (
          latestSnapshot.profileId !== snapshot.profileId ||
          latestSnapshot.projectId !== snapshot.projectId
        )
          return false;
        const current = assignmentProjectionFromAuthority({
          workItem,
          projectId,
          authority: latestSnapshot.workAuthorityByWorkItem[workItemKey(workItem)],
          role: authorityRole
        });
        if (!current) throw new Error("assignment_authority_unavailable");
        if (targetsEqual(current.target, target)) return true;
        const expectedRevision = current.revision;
        let result: { revision?: number } | null;
        if (authorityRole === "responsibility") {
          result = await controller.updateResponsibility({
            workItem,
            principal:
              target.kind === "human"
                ? { kind: "human", humanPrincipalId: target.humanPrincipalId }
                : null,
            expectedRevision
          });
        } else {
          result = await controller.updateReviewer({
            workItem,
            principal:
              target.kind === "human"
                ? { kind: "human", humanPrincipalId: target.humanPrincipalId }
                : null,
            expectedRevision
          });
        }
        mutationSucceeded = result !== null;
        if (!isCurrentRequest()) return mutationSucceeded;
        if (!result) {
          const conflict =
            controller.getSnapshot().syncPhase === "stale_conflict" ||
            controller.getSnapshot().lastError?.kind === "conflict";
          if (conflict) {
            setLocalStaleConflict(true);
          }
          const errorMessage =
            collaborationErrorMessage(controller.getSnapshot().lastError) ??
            "assignment_update_failed";
          setActionError(errorMessage);
          await controller.ensureWorkAuthority(workItem);
          if (!isCurrentRequest()) return false;
          onOutcomeRef.current?.({
            ok: false,
            workItem,
            target,
            errorMessage
          });
          return false;
        }
        setLocalStaleConflict(false);
        if (detailsOpen) {
          await loadEligible();
          if (!isCurrentRequest()) return true;
        }
        onOutcomeRef.current?.({ ok: true, workItem, target, errorMessage: null });
        return true;
      } catch (error) {
        if (!isCurrentRequest()) return mutationSucceeded;
        const errorMessage = collaborationErrorMessage(error);
        setActionError(errorMessage);
        onOutcomeRef.current?.({
          ok: false,
          workItem,
          target,
          errorMessage
        });
        return false;
      } finally {
        if (isCurrentRequest()) {
          pendingRef.current = false;
          setPending(false);
        }
      }
    },
    [
      api,
      args.workItem,
      authorityRole,
      controller,
      detailsOpen,
      labels.taskDisallowsMachine,
      loadEligible,
      projectId,
      refresh,
      snapshot.profileId,
      snapshot.projectId,
      isCurrentScope,
      sessionConnected
    ]
  );

  const selectTarget = useCallback(
    (target: AssignmentTarget) => performSelection(target),
    [performSelection]
  );
  const retryLastTarget = useCallback(async () => {
    if (!lastAttemptedTarget || !isCurrentScope()) return false;
    return performSelection(lastAttemptedTarget, true);
  }, [isCurrentScope, lastAttemptedTarget, performSelection]);

  const pickerViewModel = useMemo((): AssigneePickerViewModel | null => {
    if (!args.workItem) return null;
    const authorityLoadingKey = `authority:${workItemKey(args.workItem)}`;
    const loading =
      (detailsOpen && eligibleLoading) ||
      snapshot.loadingKinds.includes("assignments") ||
      snapshot.loadingKinds.includes(authorityLoadingKey) ||
      snapshot.loadingKinds.includes("snapshot") ||
      snapshot.syncPhase === "loading";

    return buildAssigneePickerViewModel({
      workItem: args.workItem,
      assignment,
      members: projectView.members,
      eligible,
      status,
      syncPhase: snapshot.syncPhase,
      loading,
      pending,
      staleConflict: localStaleConflict || snapshot.syncPhase === "stale_conflict",
      lastError: actionError ?? snapshot.lastError,
      query,
      labels,
      authorityRole
    });
  }, [
    actionError,
    args.workItem,
    assignment,
    authorityRole,
    detailsOpen,
    eligible,
    eligibleLoading,
    labels,
    localStaleConflict,
    pending,
    projectView.members,
    query,
    snapshot.lastError,
    snapshot.loadingKinds,
    snapshot.syncPhase,
    status
  ]);

  return {
    viewModel: pickerViewModel,
    authority,
    authorityRole,
    query,
    setQuery,
    selectTarget,
    refresh,
    retryLastTarget
  };
}
