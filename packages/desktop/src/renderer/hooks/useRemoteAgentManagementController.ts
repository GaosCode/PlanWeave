import { useCallback, useEffect, useState } from "react";
import { collaborationBridge, operatorControlBridge } from "../bridge";
import { useCollaborationStatus } from "./useCollaborationStatus";
import { useOwnerControlPlaneAvailability } from "./useOwnerControlPlaneAvailability";
import { OperatorControlError, type OperatorRemoteAgentView } from "../../shared/operatorControl";

export type RemoteAgentPeopleOption = {
  humanPrincipalId: string;
  displayName: string;
};

export type RemoteAgentWorkspaceOption = {
  workspaceId: string;
  displayName: string;
};

export type RemoteAgentManagementController = {
  agents: OperatorRemoteAgentView[];
  people: RemoteAgentPeopleOption[];
  workspaces: RemoteAgentWorkspaceOption[];
  humanPrincipalId: string | null;
  operatorProfileId: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setAccessMode: (
    endpointId: string,
    accessMode: OperatorRemoteAgentView["accessMode"],
    allowOwnerCanvas?: boolean
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

type WorkspacePickerRow = {
  workspaceId: string;
  displayName: string;
  membershipActive: boolean;
  archivedAt: string | null;
};

function collectWorkspaceOptions(input: {
  pickerItems: readonly WorkspacePickerRow[];
  canvases: readonly { workspaceId: string; canvasId: string }[];
  workspaceId: string | null | undefined;
  workspaceDisplayName: string | null | undefined;
}): RemoteAgentWorkspaceOption[] {
  const workspaceNames = new Map<string, string>();
  if (input.workspaceId && input.workspaceDisplayName) {
    workspaceNames.set(input.workspaceId, input.workspaceDisplayName);
  }
  for (const item of input.pickerItems) {
    if (!item.membershipActive || item.archivedAt) continue;
    workspaceNames.set(item.workspaceId, item.displayName);
  }
  const canvasesByWorkspace = new Map<string, string[]>();
  for (const canvas of input.canvases) {
    const labels = canvasesByWorkspace.get(canvas.workspaceId) ?? [];
    if (!labels.includes(canvas.canvasId)) labels.push(canvas.canvasId);
    canvasesByWorkspace.set(canvas.workspaceId, labels);
  }
  const workspaceIds = new Set([...workspaceNames.keys(), ...canvasesByWorkspace.keys()]);
  return [...workspaceIds].map((workspaceId) => {
    const canvasIds = canvasesByWorkspace.get(workspaceId) ?? [];
    const workspaceName = workspaceNames.get(workspaceId);
    const canvasLabel = canvasIds.length === 1 ? canvasIds[0] : "";
    return {
      workspaceId,
      displayName: workspaceName || canvasLabel || workspaceId
    };
  });
}

export function useRemoteAgentManagementController(): RemoteAgentManagementController {
  const ownerControlPlane = useOwnerControlPlaneAvailability();
  const { status } = useCollaborationStatus();
  const humanPrincipalId = ownerControlPlane.humanPrincipalId;
  const operatorProfileId = ownerControlPlane.operatorProfileId;
  const [agents, setAgents] = useState<OperatorRemoteAgentView[]>([]);
  const [people, setPeople] = useState<RemoteAgentPeopleOption[]>([]);
  const [workspaces, setWorkspaces] = useState<RemoteAgentWorkspaceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!operatorControlBridge || !operatorProfileId || !humanPrincipalId) {
      setAgents([]);
      setPeople([]);
      setWorkspaces([]);
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
      let pickerItems = status?.workspacePicker?.items ?? [];
      let canvases: { workspaceId: string; canvasId: string }[] = [];
      const collaboration = collaborationBridge;
      if (collaboration && status?.session?.phase === "connected") {
        const [members, picker, projects] = await Promise.all([
          collaboration.listCollaborationMembers({
            cursor: 0,
            limit: 100
          }),
          collaboration.listWorkspacePicker({ cursor: 0, limit: 100 }),
          collaboration.listCollaborationAuthorizedProjects({ cursor: 0, limit: 100 })
        ]);
        const canvasPages = await Promise.all(
          projects.items.map((project) =>
            collaboration.listCollaborationAuthorizedCanvases({
              projectId: project.registry.projectId,
              cursor: 0,
              limit: 100
            })
          )
        );
        setPeople(
          members.items.map((member) => ({
            humanPrincipalId: member.humanPrincipalId,
            displayName: member.displayName
          }))
        );
        pickerItems = picker.items;
        canvases = canvasPages.flatMap((page) =>
          page.items.map((canvas) => ({
            workspaceId: canvas.registry.workspaceId,
            canvasId: canvas.registry.canvasId
          }))
        );
      } else {
        setPeople([]);
      }
      setWorkspaces(
        collectWorkspaceOptions({
          pickerItems,
          canvases,
          workspaceId: status?.workspaceConnection?.workspaceId,
          workspaceDisplayName: status?.workspaceConnection?.workspaceDisplayName
        })
      );
      setError(null);
    } catch (caught) {
      setError(publicError(caught));
    } finally {
      setLoading(false);
    }
  }, [
    humanPrincipalId,
    operatorProfileId,
    status?.session?.phase,
    status?.workspaceConnection?.workspaceId,
    status?.workspaceConnection?.workspaceDisplayName,
    status?.workspacePicker?.items
  ]);

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
    workspaces,
    humanPrincipalId,
    operatorProfileId,
    loading,
    busy,
    error,
    refresh,
    setAccessMode: (endpointId, accessMode, allowOwnerCanvas) =>
      runMutation(() =>
        operatorControlBridge!.setOperatorRemoteAgentAccessMode({
          profileId: operatorProfileId!,
          humanPrincipalId: humanPrincipalId!,
          endpointId,
          accessMode,
          ...(allowOwnerCanvas === undefined ? {} : { allowOwnerCanvas })
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
