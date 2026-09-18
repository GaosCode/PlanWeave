import {
  cancelExecutionCommandSchema,
  type HistoricalMailboxCommand
} from "@planweave-ai/agent-host-protocol";

/** The persisted decision remains unchanged; only its execution can be stopped. */
export function cancellationForMailboxCommand(command: HistoricalMailboxCommand) {
  if (command.type === "cancel_execution") return command;
  if (command.type !== "interaction.permission_response" || command.decision !== "allow_once")
    return undefined;
  return cancelExecutionCommandSchema.parse({
    type: "cancel_execution",
    protocolVersion: 1,
    dispatchId: command.dispatchId,
    leaseId: command.leaseId,
    executionAttemptId: command.executionAttemptId,
    reason: "Historical permission decision cannot authorize execution."
  });
}
