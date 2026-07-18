import { runnerNextActionsSchema, type RunnerNextActions } from "./runnerContractSchemas.js";

export { runnerNextActionSchema, runnerNextActionsSchema } from "./runnerContractSchemas.js";
export type { RunnerNextActions } from "./runnerContractSchemas.js";

export function projectRunnerNextActions(options: {
  sourceRecordId: string;
  sourceRunId: string;
  recoverAcpSession: boolean;
  retryNewSession: boolean;
}): RunnerNextActions {
  return runnerNextActionsSchema.parse({
    version: "planweave.runner-next-actions/v1",
    actions: [
      ...(options.recoverAcpSession
        ? [
            {
              kind: "recover_acp_session" as const,
              sourceRecordId: options.sourceRecordId,
              sourceRunId: options.sourceRunId
            }
          ]
        : []),
      ...(options.retryNewSession
        ? [
            {
              kind: "retry_new_session" as const,
              sourceRecordId: options.sourceRecordId,
              sourceRunId: options.sourceRunId
            }
          ]
        : [])
    ]
  });
}
