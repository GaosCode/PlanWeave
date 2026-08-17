import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HumanDeviceView,
  HumanInvitationView,
  HumanMembershipView
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import { collaborationBridge } from "../bridge";
import {
  collaborationErrorMessage,
  logCollaborationRendererError
} from "../collaboration/formatCollaborationError";
import {
  buildPeopleDeviceRows,
  buildPeopleHostRows,
  buildPeopleInvitationRows,
  buildPeopleMemberRows,
  buildPeoplePresenceSummary,
  resolveCurrentMembership,
  resolvePeoplePanelMode,
  type PeopleDeviceRow,
  type PeopleHostRow,
  type PeopleInvitationRow,
  type PeopleMemberRow,
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
import { isCollaborationSessionConnected } from "../collaboration/sessionState";

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
  const activeProfileId = args.status?.activeProfileId ?? null;
  const formatError = args.formatError ?? collaborationErrorMessage;

  // The project shell may leave the shared observer unbound (local project
  // mismatch). People administration still reads members from the session.
  const members = args.members.length > 0 ? args.members : (listedMembers ?? EMPTY_MEMBERS);

  const currentMembership = useMemo(
    () =>
      resolveCurrentMembership({
        members,
        status: args.status
      }),
    [members, args.status]
  );
  const currentHumanPrincipalId = currentMembership?.humanPrincipalId ?? null;
  const currentUserIsOwner = currentMembership?.role === "owner";

  const presence = useMemo(
    () =>
      buildPeoplePresenceSummary({
        members,
        hosts: args.hosts,
        status: args.status,
        syncPhase: args.syncPhase
      }),
    [args.hosts, args.status, args.syncPhase, members]
  );

  const mode = useMemo(
    () =>
      resolvePeoplePanelMode({
        status: args.status,
        syncPhase: args.syncPhase,
        memberCount: members.length,
        detailsLoading,
        detailsFailed: detailsError !== null
      }),
    [args.status, args.syncPhase, detailsError, detailsLoading, members.length]
  );

  const memberRows = useMemo(
    () =>
      buildPeopleMemberRows({
        members,
        currentHumanPrincipalId,
        currentUserIsOwner
      }),
    [currentHumanPrincipalId, currentUserIsOwner, members]
  );

  const hostRows = useMemo(() => buildPeopleHostRows(args.hosts), [args.hosts]);
  const invitationRows = useMemo(() => buildPeopleInvitationRows(invitations), [invitations]);
  const deviceRows = useMemo(() => buildPeopleDeviceRows(devices), [devices]);

  const refreshDetails = useCallback((): Promise<void> => {
    if (!api || !sessionConnected || !activeProfileId) {
      detailsGenerationRef.current += 1;
      detailsRequestRef.current = null;
      detailsRequestKeyRef.current = null;
      setInvitations([]);
      setDevices([]);
      setListedMembers(null);
      setDetailsLoading(false);
      setDetailsError(null);
      return Promise.resolve();
    }
    const deviceScope = currentUserIsOwner ? "project" : "own";
    const requestKey = `${activeProfileId}:${deviceScope}`;
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
        const [invitationPage, devicePage, memberPage] = await Promise.all([
          currentUserIsOwner
            ? api.listCollaborationInvitations({ cursor: 0, limit: 100, openOnly: true })
            : Promise.resolve({ items: [], nextCursor: null }),
          api.listCollaborationDevices({ cursor: 0, limit: 50, scope: deviceScope }),
          api.listCollaborationMembers({ cursor: 0, limit: 100 })
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
        setListedMembers(memberPage.items);
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
  }, [activeProfileId, api, currentUserIsOwner, formatError, sessionConnected]);

  useEffect(() => {
    if (!args.detailsOpen) return;
    void refreshDetails();
  }, [args.detailsOpen, refreshDetails]);

  const runAction = useCallback(
    async (operation: () => Promise<void>, options?: { refreshDetails?: boolean }) => {
      if (!api || !sessionConnected || actionBusy) return false;
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
    [actionBusy, api, formatError, refreshDetails, sessionConnected]
  );

  return {
    mode,
    presence,
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
          await api!.updateOwnCollaborationDisplayName({ displayName });
        },
        { refreshDetails: false }
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
