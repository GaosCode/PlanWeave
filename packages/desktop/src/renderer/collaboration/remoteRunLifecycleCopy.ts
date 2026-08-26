import type { createTranslator } from "../i18n";
import type { RemoteRunLifecyclePhase } from "./remoteRunViewModels";

type Translator = ReturnType<typeof createTranslator>;

/** Shared Server-operation phase copy. Do not merge local Auto Run status into this map. */
export function remoteRunLifecyclePhaseLabel(
  phase: RemoteRunLifecyclePhase,
  t: Translator
): string {
  switch (phase) {
    case "idle":
      return t("remoteRunPhaseIdle");
    case "dispatchable":
      return t("remoteRunPhaseDispatchable");
    case "preparing":
      return t("remoteRunPreparingEnvironment");
    case "running":
      return t("remoteRunPhaseRunning");
    case "action_required":
      return t("remoteRunPhaseActionRequired");
    case "interrupted":
      return t("remoteRunPhaseInterrupted");
    case "terminal_success":
      return t("remoteRunPhaseSucceeded");
    case "terminal_failure":
      return t("remoteRunPhaseFailed");
    case "terminal_cancelled":
      return t("remoteRunPhaseCancelled");
    case "stale":
      return t("remoteRunPhaseStale");
    case "unavailable":
      return t("remoteRunPhaseUnavailable");
  }
}
