import type { ExecutorPreflightResult } from "@planweave-ai/runtime";
import type { createTranslator } from "../i18n";

interface ExecutorPreflightSummaryProps {
  result: Pick<ExecutorPreflightResult, "agentInfo" | "authentication" | "checks">;
  t: ReturnType<typeof createTranslator>;
  loginCommands?: string[] | null;
}

function initializeLabel(
  result: ExecutorPreflightSummaryProps["result"],
  t: ExecutorPreflightSummaryProps["t"]
): string {
  const initialize = result.checks?.find((check) => check.check === "acp_initialized");
  if (initialize?.status === "passed") {
    return t("preflightInitializePassed");
  }
  if (initialize?.status === "failed") {
    return t("preflightInitializeFailed");
  }
  return t("preflightNotAvailable");
}

function CommandList({ commands }: { commands: string[] }) {
  return (
    <ul className="mt-2 flex flex-col gap-1.5" data-testid="authentication-login-commands">
      {commands.map((command) => (
        <li key={command}>
          <code className="select-all break-all rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-text-strong">
            {command}
          </code>
        </li>
      ))}
    </ul>
  );
}

export function ExecutorPreflightSummary({
  result,
  t,
  loginCommands = null
}: ExecutorPreflightSummaryProps) {
  const initialize = result.checks?.find((check) => check.check === "acp_initialized");
  const authentication = result.authentication ?? null;
  const agentInfo = result.agentInfo ?? null;
  const resolvedLoginCommands = (loginCommands ?? []).filter(Boolean);
  if (!initialize && !authentication && !agentInfo) {
    return null;
  }

  return (
    <div
      className="rounded-md border border-border/70 bg-background px-3 py-3 text-xs"
      data-testid="executor-preflight-summary"
    >
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="text-text-faint">{t("preflightInitialize")}</dt>
        <dd className="text-text-strong">{initializeLabel(result, t)}</dd>
        <dt className="text-text-faint">{t("preflightAgentInfo")}</dt>
        <dd className="break-words text-text-strong">
          {agentInfo
            ? `${agentInfo.name} ${agentInfo.version}`
            : t("preflightAgentInfoNotProvided")}
        </dd>
        <dt className="text-text-faint">{t("authenticationStatus")}</dt>
        <dd className="break-words text-text-strong">
          {authentication === null
            ? t("preflightNotAvailable")
            : authentication.status === "not_advertised"
              ? t("authenticationNotAdvertised")
              : authentication.status === "authenticated"
                ? t("authenticationAuthenticated").replace("{methodId}", authentication.methodId)
                : t("authenticationActionRequired")}
        </dd>
      </dl>

      {authentication?.status === "not_advertised" ? (
        <div className="mt-3 border-t border-border/70 pt-3 text-text-faint">
          <div>{t("authenticationNotAdvertisedHint")}</div>
          {resolvedLoginCommands.length > 0 ? (
            <>
              <div className="mt-2 font-medium text-text-strong">{t("agentLoginCommandLabel")}</div>
              <CommandList commands={resolvedLoginCommands} />
            </>
          ) : null}
        </div>
      ) : null}

      {authentication?.status === "action_required" ? (
        <div className="mt-3 border-t border-border/70 pt-3">
          <div className="font-medium text-text-strong">
            {authentication.reason === "missing_credentials"
              ? t("authenticationMissingCredentials")
              : authentication.reason === "interactive_method"
                ? t("authenticationInteractiveRequired")
                : t("authenticationNoSafeMethod")}
          </div>
          <div className="mt-2 text-text-faint">{t("agentLoginCommandsHint")}</div>
          {resolvedLoginCommands.length > 0 ? (
            <>
              <div className="mt-2 font-medium text-text-strong">{t("agentLoginCommandLabel")}</div>
              <CommandList commands={resolvedLoginCommands} />
            </>
          ) : null}
          {authentication.methods.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-2" data-testid="authentication-methods">
              {authentication.methods.map((method) => (
                <li
                  className="rounded border border-border/60 bg-muted/20 px-2.5 py-2"
                  key={method.id}
                >
                  <div className="font-medium text-text-strong">{method.name}</div>
                  <div className="mt-1 text-text-faint">
                    {t("authenticationMethodId")}: <span className="font-mono">{method.id}</span>
                  </div>
                  <div className="text-text-faint">
                    {t("authenticationMethodType")}: {method.type}
                  </div>
                  {method.type === "env_var" && method.missingVariables.length > 0 ? (
                    <div className="mt-1 text-text-strong">
                      {t("authenticationMissingVariables")}: {method.missingVariables.join(", ")}
                    </div>
                  ) : null}
                  {method.type === "env_var" && method.link !== null ? (
                    <div className="mt-1 text-text-faint">
                      {t("authenticationLink")}:{" "}
                      <span
                        className="select-text break-all font-mono text-text-strong"
                        data-testid="authentication-link"
                      >
                        {method.link}
                      </span>
                    </div>
                  ) : null}
                  {method.type === "terminal" ? (
                    <div className="mt-1 text-text-faint">{t("authenticationTerminalHint")}</div>
                  ) : null}
                  {method.type === "agent" ? (
                    <div className="mt-1 text-text-faint">{t("authenticationAgentHint")}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 text-text-strong">{t("authenticationRetryHint")}</div>
          {authentication.reason === "missing_credentials" ? (
            <div className="mt-1 text-text-faint">{t("authenticationRestartHint")}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
