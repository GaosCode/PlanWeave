import type { OperatorProfileView } from "../../shared/operatorControl";
import type { createTranslator } from "../i18n";

/** Saved administrator labels can outlive a Server migration. */
export function serverProfileLabel(
  profile: OperatorProfileView,
  t: ReturnType<typeof createTranslator>
): string {
  const host = new URL(profile.serverBaseUrl).host;
  return profile.hostedByThisDesktop ? `${t("serverLocalProcess")} · ${host}` : host;
}
