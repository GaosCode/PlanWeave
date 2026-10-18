import type { CollaborationOperationScope } from "../../shared/collaborationOperationScope.js";
import type { CollaborationReadBridgePort } from "./CollaborationReadModelController.js";

type Input<K extends keyof CollaborationReadBridgePort> = CollaborationReadBridgePort[K] extends (
  input: infer I
) => unknown
  ? Omit<I, "operationScope">
  : never;

/** Each captured port retains the originating verified session through async reads and mutations. */
export function bindCollaborationReadOperations(
  api: CollaborationReadBridgePort,
  operationScope: CollaborationOperationScope
) {
  return {
    listAssignments: (input: Input<"listCollaborationAssignments">) =>
      api.listCollaborationAssignments({ ...input, operationScope }),
    listEligibleHostsBatch: (input: Input<"listCollaborationEligibleHostsBatch">) =>
      api.listCollaborationEligibleHostsBatch({ ...input, operationScope }),
    getWorkAuthority: (input: Input<"getCollaborationWorkAuthority">) =>
      api.getCollaborationWorkAuthority({ ...input, operationScope }),
    updateAssignment: (input: Input<"updateCollaborationAssignment">) =>
      api.updateCollaborationAssignment({ ...input, operationScope }),
    updateResponsibility: (input: Input<"updateCollaborationResponsibility">) =>
      api.updateCollaborationResponsibility({ ...input, operationScope }),
    updateReviewer: (input: Input<"updateCollaborationReviewer">) =>
      api.updateCollaborationReviewer({ ...input, operationScope }),
    listComments: (input: Input<"listCollaborationComments">) =>
      api.listCollaborationComments({ ...input, operationScope }),
    listActivity: (input: Input<"listCollaborationActivity">) =>
      api.listCollaborationActivity({ ...input, operationScope }),
    createComment: (input: Input<"createCollaborationComment">) =>
      api.createCollaborationComment({ ...input, operationScope }),
    editComment: (input: Input<"editCollaborationComment">) =>
      api.editCollaborationComment({ ...input, operationScope }),
    tombstoneComment: (input: Input<"tombstoneCollaborationComment">) =>
      api.tombstoneCollaborationComment({ ...input, operationScope })
  };
}
