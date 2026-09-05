import { collaborationPageQueryInputSchema } from "../../shared/collaborationReadModels";
import { isWorkspaceConnectionConnected } from "./sessionState";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import type { CollaborationReadBridgePort } from "./CollaborationReadModelController.js";

/**
 * Stable read-bridge ports for the default collaboration IPC bridge.
 * Multiple UI surfaces must share one controller/subscription; recreating a
 * fresh port object each render would defeat controller sharing.
 */
const portByApi = new WeakMap<object, CollaborationReadBridgePort>();

export function toCollaborationReadBridge(
  api: PlanWeaveCollaborationApi | null | undefined
): CollaborationReadBridgePort | null {
  if (!api) return null;
  const existing = portByApi.get(api as object);
  if (existing) return existing;
  const port: CollaborationReadBridgePort = {
    getCollaborationStatus: () => api.getCollaborationStatus(),
    listCollaborationMembers: async (input) => {
      const status = await api.getCollaborationStatus();
      return isWorkspaceConnectionConnected(status)
        ? api.listWorkspaceConnectionMembers(collaborationPageQueryInputSchema.parse(input ?? {}))
        : api.listCollaborationMembers(input);
    },
    listCollaborationAssignments: (input) => api.listCollaborationAssignments(input),
    listCollaborationEligibleAssignees: (input) => api.listCollaborationEligibleAssignees(input),
    listCollaborationEligibleHostsBatch: (input) => api.listCollaborationEligibleHostsBatch(input),
    getCollaborationWorkAuthority: (input) => api.getCollaborationWorkAuthority(input),
    updateCollaborationResponsibility: (input) => api.updateCollaborationResponsibility(input),
    updateCollaborationReviewer: (input) => api.updateCollaborationReviewer(input),
    listCollaborationComments: (input) => api.listCollaborationComments(input),
    listCollaborationActivity: (input) => api.listCollaborationActivity(input),
    updateCollaborationAssignment: (input) => api.updateCollaborationAssignment(input),
    createCollaborationComment: (input) => api.createCollaborationComment(input),
    editCollaborationComment: (input) => api.editCollaborationComment(input),
    tombstoneCollaborationComment: (input) => api.tombstoneCollaborationComment(input),
    onCollaborationStatusChanged: (callback) => api.onCollaborationStatusChanged(callback),
    onCollaborationObserverSignal: (callback) => api.onCollaborationObserverSignal(callback)
  };
  portByApi.set(api as object, port);
  return port;
}
