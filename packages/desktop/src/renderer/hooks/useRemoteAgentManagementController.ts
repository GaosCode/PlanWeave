import { useCallback, useEffect, useMemo, useState } from "react";
import { collaborationBridge, operatorControlBridge } from "../bridge";
import { resolveDesktopHumanPrincipalId } from "../collaboration/desktopHumanPrincipal";
import { useCollaborationStatus } from "./useCollaborationStatus";
import { useOwnerControlPlaneAvailability } from "./useOwnerControlPlaneAvailability";
import { OperatorControlError, type OperatorRemoteAgentView } from "../../shared/operatorControl";

export type RemoteAgentPeopleOption = {
  humanPrincipalId: string;
  displayName: string;
};

export type RemoteAgentManagementController = {
  agents: OperatorRemoteAgentView[];
  people: RemoteAgentPeopleOption[];
  humanPrincipalId: string | null;
  operatorProfileId: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setAccessMode: (
    endpointId: string,
    accessMode: OperatorRemoteAgentView["accessMode"]
  ) => Promise<boolean>;
  grantWorkspace: (endpointId: string, workspaceId: string) => Promise<boolean>;
  revokeGrant: (endpointId: string, workspaceId: string) => Promise<boolean>;
  revokeAgent: (endpointId: string) => Promise<boolean>;
  repairOwnership: (endpointId: string, ownerHumanPrincipalId: string) => Promise<boolean>;
};

function publicError(error: unknown): string {
  if (error instanceof OperatorControlError) return error.code;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "operator_request_failed";
}

export function useRemoteAgentManagementController(): RemoteAgentManagementController {
  const ownerControlPlane = useOwnerControlPlaneAvailability();
  const { status } = useCollaborationStatus();
  const humanPrincipalId = useMemo(
    () => resolveDesktopHumanPrincipalId({ collaborationStatus: status }),
    [status]
  );
  const operatorProfileId = ownerControlPlane.operatorProfileId;
  const [agents, setAgents] = useState<OperatorRemoteAgentView[]>([]);
  const [people, setPeople] = useState<RemoteAgentPeopleOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!operatorControlBridge || !operatorProfileId || !humanPrincipalId) {
      setAgents([]);
      setPeople([]);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const list = await operatorControlBridge.listOperatorRemoteAgents({
        profileId: operatorProfileId,
        humanPrincipalId
      });
      setAgents(list.items);
      if (collaborationBridge && status?.session.phase === "connected") {
        const members = await collaborationBridge.listCollaborationMembers({
          cursor: 0,
          limit: 100
        });
        setPeople(
          members.items.map((member) => ({
            humanPrincipalId: member.humanPrincipalId,
            displayName: member.displayName
          }))
        );
      } else {
        setPeople([]);
      }
      setError(null);
    } catch (caught) {
      setError(publicError(caught));
    } finally {
      setLoading(false);
    }
  }, [humanPrincipalId, operatorProfileId, status?.session.phase]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runMutation = useCallback(
    async (action: () => Promise<OperatorRemoteAgentView>): Promise<boolean> => {
      if (!operatorControlBridge || !operatorProfileId || !humanPrincipalId) return false;
      setBusy(true);
      try {
        await action();
        await refresh();
        return true;
      } catch (caught) {
        setError(publicError(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [humanPrincipalId, operatorProfileId, refresh]
  );

  return {
    agents,
    people,
    humanPrincipalId,
    operatorProfileId,
    loading,
    busy,
    error,
    refresh,
    setAccessMode: (endpointId, accessMode) =>
      runMutation(() =>
        operatorControlBridge!.setOperatorRemoteAgentAccessMode({
          profileId: operatorProfileId!,
          humanPrincipalId: humanPrincipalId!,
          endpointId,
          accessMode
        })
      ),
    grantWorkspace: (endpointId, workspaceId) =>
      runMutation(() =>
        operatorControlBridge!.grantOperatorRemoteAgentWorkspace({
          profileId: operatorProfileId!,
          humanPrincipalId: humanPrincipalId!,
          endpointId,
          workspaceId
        })
      ),
    revokeGrant: (endpointId, workspaceId) =>
      runMutation(() =>
        operatorControlBridge!.revokeOperatorRemoteAgentGrant({
          profileId: operatorProfileId!,
          humanPrincipalId: humanPrincipalId!,
          endpointId,
          workspaceId
        })
      ),
    revokeAgent: (endpointId) =>
      runMutation(() =>
        operatorControlBridge!.revokeOperatorRemoteAgent({
          profileId: operatorProfileId!,
          humanPrincipalId: humanPrincipalId!,
          endpointId
        })
      ),
    repairOwnership: (endpointId, ownerHumanPrincipalId) =>
      runMutation(() =>
        operatorControlBridge!.repairOperatorRemoteAgentOwnership({
          profileId: operatorProfileId!,
          endpointId,
          ownerHumanPrincipalId
        })
      )
  };
}
