import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import type { AppUpdateState } from "../../shared/appUpdate";
import { useAppUpdate } from "../hooks/useAppUpdate";
import type { createTranslator } from "../i18n";

type AppUpdateSettingsRowProps = {
  t: ReturnType<typeof createTranslator>;
};

function appUpdateDescription(state: AppUpdateState, t: ReturnType<typeof createTranslator>): string {
  switch (state.status) {
    case "unsupported":
      return t("appUpdateUnsupported");
    case "available":
      if (state.delivery === "github-releases") {
        return `${t("appUpdateAvailable")} · ${state.update.version} · ${t("appUpdateManualDownloadHint")}`;
      }
      return `${t("appUpdateAvailable")} · ${state.update.version}`;
    case "downloading":
      return `${t("appUpdateDownloading")} · ${Math.round(state.progress.percent)}%`;
    case "downloaded":
      return `${t("appUpdateDownloaded")} · ${state.update.version}`;
    case "not-available":
      return t("appUpdateNotAvailable");
    case "error":
      return state.error;
    default:
      return t("appUpdateHint");
  }
}

export function AppUpdateSettingsRow({ t }: AppUpdateSettingsRowProps) {
  const { appUpdateAvailable, appUpdateState, checkForAppUpdate } = useAppUpdate({ setError: () => undefined });

  return (
    <Field orientation="horizontal" className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0">
      <FieldContent className="min-w-0">
        <FieldLabel className="text-sm font-semibold">{t("appUpdate")}</FieldLabel>
        <FieldDescription className="break-words [overflow-wrap:anywhere]">{appUpdateDescription(appUpdateState, t)}</FieldDescription>
      </FieldContent>
      <Button disabled={!appUpdateAvailable || appUpdateState.status === "checking" || appUpdateState.status === "downloading"} size="sm" variant="outline" onClick={() => void checkForAppUpdate()}>
        {appUpdateState.status === "checking" ? t("checkingForAppUpdate") : t("checkForAppUpdate")}
      </Button>
    </Field>
  );
}
