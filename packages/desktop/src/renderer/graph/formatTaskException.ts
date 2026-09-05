import type { createTranslator } from "../i18n";

/** Runtime persists remote failures as [code] followed by a redacted diagnostic. */
export function formatTaskException(reason: string, t: ReturnType<typeof createTranslator>) {
  const code = /^\[([a-z][a-z0-9_]*)\] /u.exec(reason)?.[1];
  if (!code) return { message: reason, diagnostics: null };
  const key =
    code === "execution_cancelled"
      ? "remoteTaskStoppedReason"
      : code === "authentication_failed" || code === "acp_authentication_required"
        ? "remoteTaskAuthenticationReason"
        : code === "acp_operation_timeout" || code === "lease_expired"
          ? "remoteTaskTimeoutReason"
          : "remoteTaskFailedReason";
  return { message: t(key), diagnostics: reason };
}
