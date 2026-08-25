import { useCallback, useMemo } from "react";
import type { DesktopAgentDetection, DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { PlanWeaveOperatorControlApi } from "../../shared/operatorControl";
import type { DesktopSettingsUpdate, DesktopUiSettings } from "../types";
import { logicalAgentEndpointInputs } from "../collaboration/agentEndpointCatalogInput";
import {
  clearAgentEndpointPreference,
  updateAgentEndpointPreferences
} from "../collaboration/agentEndpointPreferences";
import type { AvailableAgentEndpoint } from "../collaboration/agentEndpointViewModel";
import { buildExecutorOptionViews } from "../executors/executorOptionViewModel";
import {
  useAgentEndpointCatalog,
  type AgentEndpointCatalogLocator
} from "./useAgentEndpointCatalog";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";

export function useWorkspaceAgentEndpointCatalog(input: {
  agentDetections: DesktopAgentDetection[];
  agentTransport: DesktopUiSettings["execution"]["agentTransport"];
  enabled: boolean;
  operatorProfileId: string | null;
  humanPrincipalId: string | null;
  locator: AgentEndpointCatalogLocator | null;
  fleetCatalogBlockedCode?: string | null;
  fleetApi?: Pick<PlanWeaveOperatorControlApi, "listOperatorAgentEndpoints"> | null;
  collaborationApi?: Pick<PlanWeaveCollaborationApi, "listCollaborationAgentEndpoints"> | null;
  sessionConnected?: boolean;
  graph: DesktopGraphViewModel | null;
  updateSettingsAndWait: (update: DesktopSettingsUpdate) => Promise<void>;
}) {
  const logicalExecutors = useMemo(
    () =>
      input.graph
        ? logicalAgentEndpointInputs({
            executorOptions: buildExecutorOptionViews({
              agentDetections: input.agentDetections,
              agentTransport: input.agentTransport,
              executorOptions: input.graph.executorOptions,
              literalExecutorNames: input.graph.packageExecutorNames
            }),
            profileBindings: input.graph.executorProfileBindings ?? []
          })
        : [],
    [input.agentDetections, input.agentTransport, input.graph]
  );
  const catalog = useAgentEndpointCatalog({
    enabled: input.enabled,
    fleetApi: input.fleetApi,
    fleetCatalogBlockedCode: input.fleetCatalogBlockedCode,
    logicalExecutors,
    operatorProfileId: input.operatorProfileId,
    humanPrincipalId: input.humanPrincipalId,
    locator: input.locator,
    collaborationApi: input.collaborationApi,
    sessionConnected: input.sessionConnected
  });
  const savePreference = useCallback(
    async (key: string, endpoint: AvailableAgentEndpoint | null) => {
      await input.updateSettingsAndWait((current) => ({
        execution: {
          agentEndpointPreferences: endpoint
            ? updateAgentEndpointPreferences({
                current: current.execution.agentEndpointPreferences,
                key,
                endpoint
              })
            : clearAgentEndpointPreference(current.execution.agentEndpointPreferences, key)
        }
      }));
    },
    [input.updateSettingsAndWait]
  );

  return { ...catalog, savePreference };
}
