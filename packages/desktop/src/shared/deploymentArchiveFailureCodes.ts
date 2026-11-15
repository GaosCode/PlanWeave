export const deploymentArchiveFailureCodes = {
  exportInProgress: "deployment_archive_export_in_progress",
  shuttingDown: "deployment_archive_shutting_down",
  workerStartFailed: "deployment_archive_worker_start_failed",
  workerFailed: "deployment_archive_worker_failed",
  workerExited: "deployment_archive_worker_exited",
  workerProtocolInvalid: "deployment_archive_worker_protocol_invalid",
  buildFailed: "deployment_archive_build_failed",
  destinationNotFile: "deployment_archive_destination_not_file",
  permissionsUnavailable: "deployment_archive_permissions_unavailable",
  cleanupFailed: "deployment_archive_cleanup_failed",
  committedCleanupFailed: "deployment_archive_committed_cleanup_failed"
} as const;
