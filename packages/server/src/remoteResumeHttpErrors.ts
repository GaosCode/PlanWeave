const resumeConflictCodes = new Set([
  "remote_cancel_resume_pending",
  "remote_resume_attempt_not_interrupted_and_fenced",
  "remote_resume_prior_lease_not_fenced",
  "remote_resume_recovery_evidence_missing",
  "remote_resume_recovery_identity_mismatch",
  "remote_resume_attempt_conflict",
  "remote_resume_lease_expiry_invalid"
]);

const resumeUnavailableCodes = new Set([
  "remote_resume_host_capacity_exhausted",
  "remote_resume_host_unavailable"
]);

export function remoteResumeHttpError(error: Error): { status: number; code: string } | undefined {
  const code = error.message;
  if (resumeConflictCodes.has(code)) return { status: 409, code };
  if (resumeUnavailableCodes.has(code)) return { status: 503, code };
  return undefined;
}
