import type { createTranslator } from "../i18n";
import { AppSuccessToast } from "./AppSuccessToast";
import { AppUpdateSurface } from "./AppUpdateSurface";

type AppOverlaysProps = {
  successMessage: string | null;
  setSuccessMessage: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

export function AppOverlays({ successMessage, setSuccessMessage, t }: AppOverlaysProps) {
  return (
    <>
      <AppUpdateSurface t={t} />
      <AppSuccessToast message={successMessage} onDismiss={() => setSuccessMessage(null)} t={t} />
    </>
  );
}
