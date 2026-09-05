import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HumanDeviceView,
  HumanInvitationView,
  HumanMembershipView
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import type {
  WorkspaceConnectionMemberView,
  WorkspaceConnectionSelfView
} from "@planweave-ai/collaboration-protocol/connection";
import { collaborationBridge } from "../bridge";
import {
  collaborationErrorMessage,
  logCollaborationRendererError
} from "../collaboration/formatCollaborationError";
import {
  buildPeopleDeviceRows,
  buildPeopleDeviceRowsFromWorkspace,
  buildPeopleHostRows,
  buildPeopleInvitationRows,
  buildPeopleMemberRows,
  buildPeoplePresenceSummary,
  peopleIdentityFromSelf,
  peopleMembershipsFromWorkspace,
  resolveCurrentMembership,
  resolvePeoplePanelMode,
  type PeopleDeviceRow,
  type PeopleHostRow,
  type PeopleIdentity,
  type PeopleInvitationRow,
  type PeopleMemberRow,
  type PeopleMembershipSource,
  type PeoplePanelMode,
  type PeoplePresenceSummary
} from "../collaboration/peopleViewModels";
import type {
  CollaborationInvitationHandoffView,
  CollaborationStatus,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { collaborationInvitationIdsInputSchema } from "../../shared/collaboration.js";
import type {
  CollaborationHostProjection,
  CollaborationSyncPhase
} from "../../shared/collaborationReadModels.js";
import {
  isCollaborationSessionConnected,
  isWorkspaceConnectionConnected
} from "../collaboration/sessionState";

const EMPTY_MEMBERS: HumanMembershipView[] = [];

export type UsePeoplePanelControllerArgs = {
  api?: PlanWeaveCollaborationApi | null;
  status: CollaborationStatus | null;
  members: readonly HumanMembershipView[];
  hosts: readonly CollaborationHostProjection[];
  syncPhase: CollaborationSyncPhase;
  /** When true, load owner invitations and the devices visible to the current member. */
  detailsOpen: boolean;
  /** Renderer-owned localization for typed boundary errors. */
  formatError?: (error: unknown) => string;
};

export type UsePeoplePanelControllerResult = {
  mode: PeoplePanelMode;
  presence: PeoplePresenceSummary;
  identity: PeopleIdentity | null;
  members: PeopleMemberRow[];
  hosts: PeopleHostRow[];
  invitations: PeopleInvitationRow[];
  devices: PeopleDeviceRow[];
  detailsLoading: boolean;
  detailsError: string | null;
  actionError: string | null;
  actionBusy: boolean;
  pendingInvitation: CollaborationInvitationHandoffView | null;
  clearPendingInvitation: () => void;
  clearActionError: () => void;
  refreshDetails: () => Promise<void>;
  createInvitation: () => Promise<CollaborationInvitationHandoffView | null>;
  viewInvitation: (invitationId: string) => Promise<CollaborationInvitationHandoffView | null>;
  revokeInvitation: (invitationId: string) => Promise<boolean>;
  revokeInvitations: (invitationIds: readonly string[]) => Promise<boolean>;
  updateOwnDisplayName: (displayName: string) => Promise<boolean>;
  promoteMember: (humanPrincipalId: string) => Promise<boolean>;
  demoteMember: (humanPrincipalId: string) => Promise<boolean>;
  removeMember: (humanPrincipalId: string) => Promise<boolean>;
  revokeDevice: (deviceCredentialId: string) => Promise<boolean>;
};

export function usePeoplePanelController(
  args: UsePeoplePanelControllerArgs
): UsePeoplePanelControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const [invitations, setInvitations] = useState<HumanInvitationView[]>([]);
  const [devices, setDevices] = useState<HumanDeviceView[]>([]);
  const [listedMembers, setListedMembers] = useState<HumanMembershipView[] | null>(null);
  const [workspaceSelf, setWorkspaceSelf] = useState<WorkspaceConnectionSelfView | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceConnectionMemberView[] | null>(
    null
  );
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [pendingInvitation, setPendingInvitation] =
    useState<CollaborationInvitationHandoffView | null>(null);
  const detailsGenerationRef = useRef(0);
  const detailsRequestRef = useRef<Promise<void> | null>(null);
  const detailsRequestKeyRef = useRef<string | null>(null);
  const sessionConnected = isCollaborationSessionConnected(args.status);
  const workspaceConnected = isWorkspaceConnectionConnected(args.status);
  const identityReady = workspaceConnected || sessionConnected;
  const activeProfileId = args.status?.activeProfileId ?? null;
  const formatError = args.formatError ?? collaborationErrorMessage;

  const projectMembers = args.members.length > 0 ? args.members : (listedMembers ?? EMPTY_MEMBERS);
  const usingWorkspaceMembers = workspaceMembers !== null && workspaceMembers.length > 0;
  const membershipSources: readonly PeopleMembershipSource[] = usingWorkspaceMembers
    ? peopleMembershipsFromWorkspace(workspaceMembers)
    : projectMembers;

  const currentMembership = useMemo(
    () =>
      resolveCurrentMembership({
        members: membershipSources,
        status: args.status
      }),
    [membershipSources, args.status]
  );
  const currentHumanPrincipalId =
    workspaceSelf?.humanPrincipalId ?? currentMembership?.humanPrincipalId ?? null;
  const projectMemberIds = useMemo(
    () => new Set(projectMembers.map((member) => member.humanPrincipalId)),
    [projectMembers]
  );
  const currentUserIsProjectOwner =
    projectMembers.find((member) => member.humanPrincipalId === currentHumanPrincipalId)?.role ===
    "owner";

  const presence = useMemo(
    () =>
      buildPeoplePresenceSummary({
        members: membershipSources,
        hosts: args.hosts,
        status: args.status,
        syncPhase: args.syncPhase
      }),
    [args.hosts, args.status, args.syncPhase, membershipSources]
  );
  const presenceWithProjectOwner = useMemo(
    () => ({
      ...presence,
      currentUserIsOwner: currentUserIsProjectOwner
    }),
    [currentUserIsProjectOwner, presence]
  );

  const mode = useMemo(
    () =>
      resolvePeoplePanelMode({
        status: args.status,
        syncPhase: args.syncPhase,
        memberCount: membershipSources.length,
        detailsLoading,
        detailsFailed: detailsError !== null
      }),
    [args.status, args.syncPhase, detailsError, detailsLoading, membershipSources.length]
  );

  const memberRows = useMemo(
    () =>
      buildPeopleMemberRows({
        members: membershipSources,
        currentHumanPrincipalId,
        currentUserIsOwner: currentUserIsProjectOwner,
        projectMemberIds: usingWorkspaceMembers ? projectMemberIds : undefined
      }),
    [
      currentHumanPrincipalId,
      currentUserIsProjectOwner,
      membershipSources,
      projectMemberIds,
      usingWorkspaceMembers
    ]
  );

  const hostRows = useMemo(() => buildPeopleHostRows(args.hosts), [args.hosts]);
  const invitationRows = useMemo(() => buildPeopleInvitationRows(invitations), [invitations]);
  const deviceRows = useMemo(() => {
    if (usingWorkspaceMembers) {
      return buildPeopleDeviceRowsFromWorkspace(
        workspaceMembers.flatMap((member) => member.devices)
      );
    }
    return buildPeopleDeviceRows(devices);
  }, [devices, usingWorkspaceMembers, workspaceMembers]);
  const identity = workspaceSelf ? peopleIdentityFromSelf(workspaceSelf) : null;

  const clearIdentityState = useCallback(() => {
    setInvitations([]);
    setDevices([]);
    setListedMembers(null);
    setWorkspaceSelf(null);
    setWorkspaceMembers(null);
    setDetailsLoading(false);
    setDetailsError(null);
  }, []);

  const refreshDetails = useCallback((): Promise<void> => {
    if (!api || !identityReady || !activeProfileId) {
      detailsGenerationRef.current += 1;
      detailsRequestRef.current = null;
      detailsRequestKeyRef.current = null;
      clearIdentityState();
      return Promise.resolve();
    }
    const deviceScope = currentUserIsProjectOwner ? "project" : "own";
    const requestKey = `${activeProfileId}:${deviceScope}:${workspaceConnected}:${sessionConnected}`;
    if (detailsRequestRef.current && detailsRequestKeyRef.current === requestKey) {
      return detailsRequestRef.current;
    }
    const generation = detailsGenerationRef.current + 1;
    detailsGenerationRef.current = generation;
    detailsRequestKeyRef.current = requestKey;
    setDetailsLoading(true);
    setDetailsError(null);
    const request = (async () => {
      try {
        if (workspaceConnected) {
          const self = await api.getWorkspaceConnectionSelf();
          if (detailsGenerationRef.current !== generation) {
            return;
          }
          setWorkspaceSelf(self);
          const workspaceMemberPage = await api.listWorkspaceConnectionMembers({
            cursor: 0,
            limit: 100
          });
          if (detailsGenerationRef.current !== generation) {
            return;
          }
          setWorkspaceMembers(workspaceMemberPage.items);
        } else {
          setWorkspaceSelf(null);
          setWorkspaceMembers(null);
        }
        const [invitationPage, devicePage, memberPage] = await Promise.all([
          sessionConnected && currentUserIsProjectOwner
            ? api.listCollaborationInvitations({ cursor: 0, limit: 100, openOnly: true })
            : Promise.resolve({ items: [], nextCursor: null }),
          sessionConnected
            ? api.listCollaborationDevices({ cursor: 0, limit: 50, scope: deviceScope })
            : Promise.resolve({ items: [], nextCursor: null }),
          sessionConnected
            ? api.listCollaborationMembers({ cursor: 0, limit: 100 })
            : Promise.resolve({ items: [], nextCursor: null })
        ]);
        if (detailsGenerationRef.current !== generation) {
          return;
        }
        setInvitations(
          [...invitationPage.items].sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt)
          )
        );
        setDevices(devicePage.items);
        setListedMembers(sessionConnected ? memberPage.items : null);
      } catch (error) {
        if (detailsGenerationRef.current !== generation) {
          return;
        }
        logCollaborationRendererError("people.refreshDetails", error);
        setDetailsError(formatError(error));
      } finally {
        if (detailsGenerationRef.current === generation) {
          setDetailsLoading(false);
        }
      }
    })();
    detailsRequestRef.current = request;
    void request.finally(() => {
      if (detailsRequestRef.current === request) {
        detailsRequestRef.current = null;
        detailsRequestKeyRef.current = null;
      }
    });
    return request;
  }, [
    activeProfileId,
    api,
    clearIdentityState,
    currentUserIsProjectOwner,
    formatError,
    identityReady,
    sessionConnected,
    workspaceConnected
  ]);

  useEffect(() => {
    if (!args.detailsOpen) return;
    void refreshDetails();
  }, [args.detailsOpen, refreshDetails]);

  const runAction = useCallback(
    async (
      operation: () => Promise<void>,
      options?: { refreshDetails?: boolean; requireProjectSession?: boolean }
    ) => {
      const requiresProject = options?.requireProjectSession !== false;
      if (!api || actionBusy) return false;
      if (requiresProject ? !sessionConnected : !identityReady) return false;
      setActionBusy(true);
      setActionError(null);
      try {
        await operation();
        if (options?.refreshDetails !== false) {
          await refreshDetails();
        }
        return true;
      } catch (error) {
        logCollaborationRendererError("people.action", error);
        setActionError(formatError(error));
        return false;
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, api, formatError, identityReady, refreshDetails, sessionConnected]
  );

  return {
    mode,
    presence: presenceWithProjectOwner,
    identity,
    members: memberRows,
    hosts: hostRows,
    invitations: invitationRows,
    devices: deviceRows,
    detailsLoading,
    detailsError,
    actionError,
    actionBusy,
    pendingInvitation,
    clearPendingInvitation: () => setPendingInvitation(null),
    clearActionError: () => setActionError(null),
    refreshDetails,
    createInvitation: async () => {
      if (!api || !sessionConnected || actionBusy) return null;
      setActionBusy(true);
      setActionError(null);
      try {
        const created = await api.createCollaborationInvitationHandoff({
          idempotencyKey: globalThis.crypto.randomUUID()
        });
        setPendingInvitation(created);
        setInvitations((current) => [
          ...current.filter(
            (invitation) => invitation.invitationId !== created.invitation.invitationId
          ),
          created.invitation
        ]);
        await refreshDetails();
        return created;
      } catch (error) {
        logCollaborationRendererError("people.createInvitation", error);
        setActionError(formatError(error));
        return null;
      } finally {
        setActionBusy(false);
      }
    },
    viewInvitation: async (invitationId) => {
      if (!api || !sessionConnected || actionBusy) return null;
      setActionBusy(true);
      setActionError(null);
      try {
        const invitation = await api.getCollaborationInvitationHandoff({ invitationId });
        setPendingInvitation(invitation);
        return invitation;
      } catch (error) {
        logCollaborationRendererError("people.viewInvitation", error);
        setActionError(formatError(error));
        return null;
      } finally {
        setActionBusy(false);
      }
    },
    revokeInvitation: async (invitationId) =>
      runAction(
        async () => {
          const revoked = await api!.revokeCollaborationInvitation({ invitationId });
          setInvitations((current) =>
            current.filter((invitation) => invitation.invitationId !== revoked.invitationId)
          );
          setPendingInvitation((current) =>
            current?.invitation.invitationId === revoked.invitationId ? null : current
          );
        },
        { refreshDetails: false }
      ),
    revokeInvitations: async (invitationIds) =>
      runAction(
        async () => {
          const input = collaborationInvitationIdsInputSchema.parse({
            invitationIds: [...invitationIds]
          });
          const revoked = await api!.revokeCollaborationInvitations(input);
          const revokedIds = new Set(revoked.items.map((invitation) => invitation.invitationId));
          setInvitations((current) =>
            current.filter((invitation) => !revokedIds.has(invitation.invitationId))
          );
          setPendingInvitation((current) =>
            current && revokedIds.has(current.invitation.invitationId) ? null : current
          );
        },
        { refreshDetails: false }
      ),
    updateOwnDisplayName: async (displayName) =>
      runAction(
        async () => {
          if (workspaceConnected) {
            const updated = await api!.updateWorkspaceConnectionSelf({ displayName });
            setWorkspaceSelf(updated);
            setWorkspaceMembers((current) =>
              current
                ? current.map((member) =>
                    member.humanPrincipalId === updated.humanPrincipalId
                      ? { ...member, displayName: updated.displayName }
                      : member
                  )
                : current
            );
            return;
          }
          await api!.updateOwnCollaborationDisplayName({ displayName });
        },
        { refreshDetails: false, requireProjectSession: false }
      ),
    promoteMember: async (humanPrincipalId) =>
      runAction(
        async () => {
          await api!.promoteCollaborationOwner({ humanPrincipalId });
        },
        { refreshDetails: false }
      ),
    demoteMember: async (humanPrincipalId) =>
      runAction(
        async () => {
          await api!.demoteCollaborationOwner({ humanPrincipalId });
        },
        { refreshDetails: false }
      ),
    removeMember: async (humanPrincipalId) =>
      runAction(
        async () => {
          await api!.removeCollaborationMember({ humanPrincipalId });
        },
        { refreshDetails: false }
      ),
    revokeDevice: async (deviceCredentialId) =>
      runAction(
        async () => {
          await api!.revokeCollaborationDevice({ deviceCredentialId });
          setDevices((current) =>
            current.filter((device) => device.deviceCredentialId !== deviceCredentialId)
          );
        },
        { refreshDetails: false }
      )
  };
}
