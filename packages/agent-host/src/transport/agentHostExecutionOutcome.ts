import { AgentHostExecutionError } from "../execution/agentHostExecutor.js";

export function executionFailure(error: unknown, aborted: boolean) {
  if (aborted) {
    return {
      code: "execution_cancelled",
      message: "The execution was cancelled by the coordinator.",
      retryable: false
    };
  }
  if (error instanceof AgentHostExecutionError) return error.failure;
  if (
    error instanceof Error &&
    (error.message.startsWith("artifact_upload_failed:") ||
      error.message.startsWith("artifact_download_failed:") ||
      error.message.startsWith("artifact_download_"))
  ) {
    return {
      code: "artifact_upload_failed",
      message: "The Agent Host could not transfer an execution artifact.",
      retryable: true
    };
  }
  return {
    code: "executor_failed",
    message: "The Agent Host executor failed.",
    retryable: false
  };
}

export function executionCleanupFailed(error: unknown): boolean {
  if (error instanceof AgentHostExecutionError) {
    return (
      error.failure.code === "acp_cleanup_failed" ||
      error.failure.code === "workspace_input_cleanup_failed"
    );
  }
  return (
    error instanceof AggregateError &&
    error.message === "remote_acp_execution_and_input_cleanup_failed"
  );
}
