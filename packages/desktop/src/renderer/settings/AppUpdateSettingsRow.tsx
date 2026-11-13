import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import type { AppUpdateState } from "../../shared/appUpdate";
import { useAppUpdate } from "../components/AppUpdateProvider";
import type { createTranslator } from "../i18n";

type AppUpdateSettingsRowProps = {
  t: ReturnType<typeof createTranslator>;
};

function appUpdateDescription(
  state: AppUpdateState | null,
  t: ReturnType<typeof createTranslator>
): string {
  switch (state?.status) {
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
  const appUpdate = useAppUpdate();
  const appUpdateState = appUpdate?.appUpdateState ?? null;
  const status = appUpdateState?.status;
  const disabled = !appUpdate?.appUpdateAvailable || status === "unsupported";
  const busy =
    Boolean(appUpdate?.appUpdatePending) || status === "checking" || status === "downloading";
  let action = appUpdate?.checkForAppUpdate;
  let actionLabel = t("checkForAppUpdate");

  switch (appUpdateState?.status) {
    case "available":
      action = appUpdate?.downloadAppUpdate;
      actionLabel =
        appUpdateState.delivery === "github-releases"
          ? t("downloadAppUpdateFromReleases")
          : t("downloadAppUpdate");
      break;
    case "downloaded":
      if (appUpdateState.delivery === "in-app") {
        action = appUpdate?.installAppUpdate;
        actionLabel = t("restartToInstallUpdate");
      }
      break;
    case "checking":
      actionLabel = t("checkingForAppUpdate");
      break;
    case "downloading":
      actionLabel = t("appUpdateDownloading");
      break;
  }

  return (
    <Field
      orientation="horizontal"
      className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0"
    >
      <FieldContent className="min-w-0">
        <FieldLabel className="text-sm font-semibold">{t("appUpdate")}</FieldLabel>
        <FieldDescription className="break-words [overflow-wrap:anywhere]">
          {appUpdate?.appUpdateAvailable
            ? appUpdateDescription(appUpdateState, t)
            : t("appUpdateBridgeUnavailable")}
        </FieldDescription>
        {appUpdate?.appUpdateAvailable && appUpdate.appUpdateError ? (
          <FieldDescription
            className="break-words text-destructive [overflow-wrap:anywhere]"
            role="alert"
          >
            {t("appUpdateRequestFailed")} {appUpdate.appUpdateError}
          </FieldDescription>
        ) : null}
      </FieldContent>
      <Button
        aria-disabled={busy || undefined}
        className="aria-disabled:opacity-50"
        disabled={disabled}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => {
          if (disabled || busy) return;
          void action?.();
        }}
      >
        {actionLabel}
      </Button>
    </Field>
  );
}
