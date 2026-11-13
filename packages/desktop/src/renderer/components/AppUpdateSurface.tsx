import type { createTranslator } from "../i18n";
import { useAppUpdate } from "./AppUpdateProvider";
import { AppUpdateToast } from "./AppUpdateToast";

type AppUpdateSurfaceProps = {
  t: ReturnType<typeof createTranslator>;
};

export function AppUpdateSurface({ t }: AppUpdateSurfaceProps) {
  const appUpdate = useAppUpdate();
  if (!appUpdate?.appUpdateAvailable || !appUpdate.appUpdateState) return null;

  return (
    <AppUpdateToast
      actionError={appUpdate.appUpdateError}
      actionPending={appUpdate.appUpdatePending}
      onCheck={appUpdate.checkForAppUpdate}
      onDownload={appUpdate.downloadAppUpdate}
      onInstall={appUpdate.installAppUpdate}
      state={appUpdate.appUpdateState}
      t={t}
    />
  );
}
