import type { createTranslator } from "../i18n";
import { AppErrorBanner } from "./AppErrorBanner";
import { AppSuccessToast } from "./AppSuccessToast";
import { AppUpdateSurface } from "./AppUpdateSurface";

type AppOverlaysProps = {
  error: string | null;
  successMessage: string | null;
  setError: (message: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

export function AppOverlays({
  error,
  successMessage,
  setError,
  setSuccessMessage,
  t
}: AppOverlaysProps) {
  return (
    <>
      <AppUpdateSurface setError={setError} t={t} />
      <AppSuccessToast message={successMessage} onDismiss={() => setSuccessMessage(null)} t={t} />
      <AppErrorBanner message={error} onDismiss={() => setError(null)} t={t} />
    </>
  );
}
