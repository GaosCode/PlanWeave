import type { createTranslator } from "../i18n";
import { AppErrorBanner } from "./AppErrorBanner";
import { AppUpdateSurface } from "./AppUpdateSurface";

type AppOverlaysProps = {
  error: string | null;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

export function AppOverlays({ error, setError, t }: AppOverlaysProps) {
  return (
    <>
      <AppUpdateSurface setError={setError} t={t} />
      <AppErrorBanner message={error} onDismiss={() => setError(null)} t={t} />
    </>
  );
}
