import { useCallback } from "react";
import type { DesktopUiSettings } from "../types";
import type { AvailableAgentEndpoint } from "../collaboration/agentEndpointViewModel";
import {
  agentEndpointPreferenceKey,
  agentEndpointSelectionId,
  remoteAgentEndpointPreferenceKey,
  selectedAgentEndpointId
} from "../collaboration/agentEndpointPreferences";
import { changeAgentEndpointSelection } from "../collaboration/changeAgentEndpoint";

export function useTaskAgentEndpointSelection(input: {
  agentEndpoints: readonly AvailableAgentEndpoint[];
  canvasId: string | null;
  changeLogicalExecutor: (taskId: string, executorName: string) => Promise<boolean>;
  currentLogicalExecutorName: (taskId: string) => string | null;
  preferences: DesktopUiSettings["execution"]["agentEndpointPreferences"];
  projectRoot: string | null;
  remoteCanvas?: { workspaceId: string; projectId: string; canvasId: string } | null;
  requireExplicitEndpoint?: boolean;
  savePreference: (key: string, endpoint: AvailableAgentEndpoint | null) => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const preferenceKey = useCallback(
    (taskId: string) =>
      input.projectRoot && input.canvasId
        ? agentEndpointPreferenceKey({
            projectRoot: input.projectRoot,
            canvasId: input.canvasId,
            scope: { kind: "task", taskId }
          })
        : input.remoteCanvas
          ? remoteAgentEndpointPreferenceKey({
              ...input.remoteCanvas,
              scope: { kind: "task", taskId }
            })
          : null,
    [input.canvasId, input.projectRoot, input.remoteCanvas]
  );
  const selectedEndpointId = useCallback(
    (taskId: string, executorName: string) => {
      const key = preferenceKey(taskId);
      return agentEndpointSelectionId(
        selectedAgentEndpointId({
          executorName,
          preference: key ? input.preferences[key] : undefined,
          endpoints: input.agentEndpoints,
          defaultMode: input.requireExplicitEndpoint ? "unassigned" : "local"
        })
      );
    },
    [input.agentEndpoints, input.preferences, input.requireExplicitEndpoint, preferenceKey]
  );
  const changeEndpoint = useCallback(
    async (taskId: string, endpointId: string) => {
      await changeAgentEndpointSelection({
        endpointId,
        endpoints: input.agentEndpoints,
        preferenceKey: preferenceKey(taskId),
        currentLogicalExecutorName: input.currentLogicalExecutorName(taskId),
        changeLogicalExecutor: async (executorName) => {
          if (executorName === null) return false;
          return input.changeLogicalExecutor(taskId, executorName);
        },
        savePreference: input.savePreference,
        setError: input.setError
      });
    },
    [
      input.agentEndpoints,
      input.changeLogicalExecutor,
      input.currentLogicalExecutorName,
      input.savePreference,
      input.setError,
      preferenceKey
    ]
  );

  return { changeEndpoint, selectedEndpointId };
}
