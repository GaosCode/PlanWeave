import type { createTranslator } from "./i18n";
import type { RunnerInteractionIpcError } from "@planweave-ai/runtime";

export function runnerInteractionAvailabilityLabel(
  reason: string | null,
  t: ReturnType<typeof createTranslator>
): string | null {
  switch (reason) {
    case "answered":
      return t("acpInteractionUnavailableAnswered");
    case "expired":
      return t("acpInteractionUnavailableExpired");
    case "owner_unavailable":
      return t("acpInteractionUnavailableOwner");
    case "owner_replaced":
      return t("acpInteractionUnavailableReplaced");
    case "run_terminal":
      return t("acpInteractionUnavailableTerminal");
    case "legacy_history":
      return t("acpInteractionUnavailableLegacy");
    case "contract_invalid":
      return t("acpInteractionUnavailableContract");
    default:
      return reason;
  }
}

export function runnerInteractionErrorLabel(
  error: RunnerInteractionIpcError,
  t: ReturnType<typeof createTranslator>
): string {
  switch (error.code) {
    case "interaction_already_answered":
      return t("acpInteractionUnavailableAnswered");
    case "interaction_owner_unavailable":
      return t("acpInteractionUnavailableOwner");
    case "interaction_owner_replaced":
      return t("acpInteractionUnavailableReplaced");
    case "interaction_run_terminal":
      return t("acpInteractionUnavailableTerminal");
    case "interaction_contract_invalid":
      return t("acpInteractionUnavailableContract");
    default:
      return error.message;
  }
}
