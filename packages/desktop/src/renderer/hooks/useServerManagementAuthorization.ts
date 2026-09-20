import { useEffect, useRef, useState } from "react";
import type { OperatorControlStatus } from "../../shared/operatorControl";
import type { OperatorManagementView } from "../../shared/operatorManagement";
import { operatorControlBridge } from "../bridge";
import { hostAdministrationErrorCode } from "../settings/hostAdministrationErrors";

export function useServerManagementAuthorization() {
  const [status, setStatus] = useState<OperatorControlStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const refreshCheck = useRef<(() => void) | null>(null);
  const [verifiedId, setVerifiedId] = useState<string | null>(null);
  const [management, setManagement] = useState<OperatorManagementView | null>(null);
  useEffect(() => {
    if (!operatorControlBridge) return;
    let active = true;
    const update = (next: OperatorControlStatus) => {
      if (active) setStatus(next);
    };
    const unsubscribe = operatorControlBridge.onOperatorControlStatusChanged(update);
    void operatorControlBridge.getOperatorControlStatus().then(update, (cause) => {
      if (active) setError(hostAdministrationErrorCode(cause));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const profileId = selectedId ?? status?.activeProfileId;
  const profile = status?.profiles.find((item) => item.profileId === profileId);
  useEffect(() => {
    setManagement(null);
    if (!operatorControlBridge || !profileId) return;
    let active = true;
    const refresh = () => {
      setChecking(true);
      void operatorControlBridge!
        .getManagementAuthorization({ profileId })
        .then(
          (view) => {
            if (active) setManagement(view);
          },
          (cause) => {
            if (active) setError(hostAdministrationErrorCode(cause));
          }
        )
        .finally(() => {
          if (active) setChecking(false);
        });
    };
    refreshCheck.current = refresh;
    refresh();
    const timer = setInterval(refresh, 5 * 60_000);
    return () => {
      active = false;
      clearInterval(timer);
      refreshCheck.current = null;
    };
  }, [profileId]);
  const run = async (operation: "import" | "reauthorize" | "recover", recoveryCode?: string) => {
    if (!operatorControlBridge || !profile || busy) return false;
    setBusy(true);
    setError(null);
    setVerifiedId(null);
    try {
      if (operation === "import") {
        setStatus(
          await operatorControlBridge.importOperatorCredential({
            profileId: profile.profileId,
            verifyBeforeSave: true
          })
        );
        setManagement(
          await operatorControlBridge.getManagementAuthorization({ profileId: profile.profileId })
        );
      } else {
        const next =
          operation === "recover"
            ? await operatorControlBridge.recoverManagement({
                profileId: profile.profileId,
                recoveryCode: recoveryCode ?? ""
              })
            : await operatorControlBridge.reauthorizeManagement({ profileId: profile.profileId });
        setManagement(next);
        setStatus(await operatorControlBridge.getOperatorControlStatus());
      }
      setVerifiedId(profile.profileId);
      return true;
    } catch (cause) {
      setError(hostAdministrationErrorCode(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    status,
    profileId,
    profile,
    busy,
    checking,
    management,
    error,
    verifiedId,
    refresh: () => {
      setError(null);
      setVerifiedId(null);
      refreshCheck.current?.();
    },
    importCredential: () => run("import"),
    reauthorize: () => run("reauthorize"),
    recover: (code: string) => run("recover", code),
    selectProfile: (id: string) => {
      setSelectedId(id);
      setError(null);
      setVerifiedId(null);
    }
  };
}
