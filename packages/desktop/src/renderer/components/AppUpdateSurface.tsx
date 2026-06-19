import { useAppUpdate } from "../hooks/useAppUpdate";
import type { createTranslator } from "../i18n";
import { AppUpdateToast } from "./AppUpdateToast";

type AppUpdateSurfaceProps = {
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

export function AppUpdateSurface({ setError, t }: AppUpdateSurfaceProps) {
  const appUpdate = useAppUpdate({ setError });

  return (
    <AppUpdateToast
      onCheck={appUpdate.checkForAppUpdate}
      onDownload={appUpdate.downloadAppUpdate}
      onInstall={appUpdate.installAppUpdate}
      state={appUpdate.appUpdateState}
      t={t}
    />
  );
}
